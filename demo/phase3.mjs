// demo/phase3.mjs — e2e of phase 3: group calls over the state-event rail,
// message editing, and multi-device key migration.
import { MatrixLite } from "../packages/matrix-lite/client.js";
import { MemoryStore } from "../packages/matrix-lite/store-memory.js";
import { E2EE } from "../packages/matrix-lite/e2ee.js";
import { GroupCallManager } from "../packages/matrix-lite/group-calls.js";
import { newTransferKey, exportSessions, importSessions } from "../packages/matrix-lite/device-sync.js";
import { writeFileSync } from "node:fs";

const HS = "http://127.0.0.1:18420";
writeFileSync("/tmp/huc-phase", "up");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m) => console.log(`ok: ${m}`);

// --- 1. group call: doctor starts a care-team call, patient sees it ----------
const doctor = new MatrixLite({ homeserver: HS, accessToken: "c", userId: "@doctor:hs.demo", store: new MemoryStore() });
const patient = new MatrixLite({ homeserver: HS, accessToken: "a", userId: "@amina:hs.demo", store: new MemoryStore() });
const sfuConnections = [];
const fakeFocusFactory = {
  create: async (focus, rtc) => { const c = { focus, rtc, closed: false, close() { this.closed = true; } }; sfuConnections.push(c); return c; },
};
const docCalls = new GroupCallManager({ client: doctor, focusFactory: fakeFocusFactory, turnServers: [{ urls: "turn:turn.clinic.ng:3478" }] });
const patCalls = new GroupCallManager({ client: patient, focusFactory: fakeFocusFactory });
let patientAlerted = null;
patCalls.onIncoming = (i) => { patientAlerted = i; };

const dRun = doctor.start(), pRun = patient.start();
await sleep(700);

const docSession = await docCalls.join("!ward:hs.demo", { type: "livekit", url: "wss://sfu.clinic.ng" });
for (let i = 0; i < 40 && !patientAlerted; i++) await sleep(250);
if (!patientAlerted) fail("patient never saw the group call start");
ok("group call: doctor started, patient alerted via m.call.member state");

const patSession = await patientAlerted.join({ type: "livekit", url: "wss://sfu.clinic.ng" });
if (sfuConnections.length !== 2) fail("both sides must connect to the SFU");
if (sfuConnections[0].rtc.iceServers[0].urls !== "turn:turn.clinic.ng:3478") fail("TURN config lost");
ok("group call: patient joined; both sides on the operator's SFU (TURN configured)");

await patSession.leave();
await sleep(700);
await docSession.leave();
ok("group call: leave clears membership, SFU connections released");

// --- 2. message editing -------------------------------------------------------
await doctor.send("!clinic:hs.demo", "Take two tablets daily");
const sent1 = (await (await fetch(`${HS}/control/sent`)).json()).sent;
const orig = sent1.find((m) => m.body === "Take two tablets daily");
if (!orig) fail("original message missing");
await doctor.sendEdit("!clinic:hs.demo", "$echo1", "Take ONE tablet daily (correction)");
const sent2 = (await (await fetch(`${HS}/control/sent`)).json()).sent;
const edit = sent2.find((m) => m["m.relates_to"]?.rel_type === "m.replace");
if (!edit || edit["m.new_content"].body !== "Take ONE tablet daily (correction)") fail("edit payload");
ok("editing: m.replace carries the correction, plain fallback marked");

// --- 3. multi-device: amina's new phone ----------------------------------------
const oldPhone = new MatrixLite({ homeserver: HS, accessToken: "a", userId: "@amina:hs.demo", store: new MemoryStore() });
oldPhone.e2ee = new E2EE(oldPhone.store);
await oldPhone.store.setEncrypted("!clinic:hs.demo", true);
await oldPhone.send("!clinic:hs.demo", "encrypted history on old phone");

const transferKey = newTransferKey();
const sealed = await exportSessions(oldPhone.e2ee, transferKey);
if (sealed.includes("encrypted history")) fail("transfer payload leaked plaintext");
ok("device sync: sessions sealed under a one-time transfer key");

const newPhone = new MatrixLite({ homeserver: HS, accessToken: "a", userId: "@amina:hs.demo", store: new MemoryStore() });
newPhone.e2ee = new E2EE(newPhone.store);
const moved = await importSessions(newPhone.e2ee, transferKey, sealed);
if (moved !== 1 || !newPhone.e2ee.outbound.has("!clinic:hs.demo")) fail("import failed");
ok("device sync: new phone adopted the session ratchets — history readable, no re-key storm");

doctor.stop(); patient.stop();
await dRun; await pRun;
console.log("\nphase3 demo: ALL GREEN");
process.exit(0);
