// demo/phase2.mjs — e2e of the phase-2 gap list over the fake homeserver:
// E2EE roundtrip between two clients, a call signaling exchange, reactions.
import { MatrixLite } from "../packages/matrix-lite/client.js";
import { MemoryStore } from "../packages/matrix-lite/store-memory.js";
import { E2EE } from "../packages/matrix-lite/e2ee.js";
import { CallManager } from "../packages/matrix-lite/calls.js";
import { writeFileSync } from "node:fs";

const HS = "http://127.0.0.1:18420";
writeFileSync("/tmp/huc-phase", "up");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m) => console.log(`ok: ${m}`);

// --- two clients on one homeserver ------------------------------------------
const amina = new MatrixLite({ homeserver: HS, accessToken: "a", userId: "@amina:hs.demo", store: new MemoryStore() });
amina.e2ee = new E2EE(amina.store);
const clinic = new MatrixLite({ homeserver: HS, accessToken: "c", userId: "@clinic:hs.demo", store: new MemoryStore() });
clinic.e2ee = new E2EE(clinic.store);
const clinicGot = [];
clinic.onEvent = (r, ev) => clinicGot.push(ev);

const aminaRun = amina.start();
const clinicRun = clinic.start();
await sleep(700);

// --- 1. E2EE: amina encrypts; key share rides to-device; clinic reads --------
await amina.enableEncryption("!clinic:hs.demo");
await amina.send("!clinic:hs.demo", "My BP this morning: 128/84. Any worry?");
let plain = null;
for (let i = 0; i < 40 && !plain; i++) {
  await sleep(250);
  const ev = clinicGot.find((e) => e.decrypted);
  if (ev) plain = ev.content.body;
}
if (!plain || !plain.includes("128/84")) fail("clinic never decrypted the message");
ok("E2EE: encrypted on the wire, key shared to-device, clinic decrypted");

// --- 2. wire really is ciphertext --------------------------------------------
const sentRes = await fetch(`${HS}/control/sent`);
const sentAll = (await sentRes.json()).sent;
const enc = sentAll.find((m) => m.algorithm === "ng.huc.megolm.v1");
if (!enc) fail("no m.room.encrypted payload reached the server");
if (JSON.stringify(enc).includes("128/84")) fail("plaintext leaked to the wire");
ok("E2EE: homeserver holds ciphertext only (operator-blind)");

// --- 3. call signaling: amina invites, clinic rings and answers ---------------
const sdpStore = { pc: null };
const fakeRtc = {
  createPeer: () => (sdpStore.pc = {
    tracks: [], remote: null, local: null,
    addTrack(t) { this.tracks.push(t); },
    async createOffer() { return { type: "offer", sdp: "AMINA-OFFER" }; },
    async createAnswer() { return { type: "answer", sdp: "CLINIC-ANSWER" }; },
    async setLocalDescription(d) { this.local = d; },
    async setRemoteDescription(d) { this.remote = d; },
    async addIceCandidate() {}, close() {},
  }),
  getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
};
const aminaCalls = new CallManager({ client: amina, rtc: fakeRtc, turnServers: [{ urls: "turn:turn.clinic.ng:3478" }] });
const clinicCalls = new CallManager({ client: clinic, rtc: fakeRtc });
let ringing = null;
clinicCalls.onIncoming = (s) => { ringing = s; };

const outbound = await aminaCalls.placeCall("!clinic:hs.demo", { video: false });
for (let i = 0; i < 40 && !ringing; i++) await sleep(250);
if (!ringing) fail("clinic never rang");
ok("calls: invite signaled, clinic ringing");

await ringing.answer({ video: false });
for (let i = 0; i < 40 && outbound.state !== "connected"; i++) await sleep(250);
if (outbound.state !== "connected") fail(`outbound state ${outbound.state}`);
ok("calls: SDP offer/answer exchanged — connected");

await outbound.hangup();
for (let i = 0; i < 40 && ringing.state !== "ended"; i++) await sleep(250);
if (ringing.state !== "ended") fail("clinic side never saw hangup");
ok("calls: hangup propagated, both sides ended");

// --- 4. reaction round trip ----------------------------------------------------
await clinic.sendReaction("!clinic:hs.demo", "$echo1", "👍");
await sleep(700);
const sent2 = (await (await fetch(`${HS}/control/sent`)).json()).sent;
const reaction = sent2.find((m) => m["m.relates_to"]?.key === "👍");
if (!reaction) fail("reaction never sent");
ok("social: reaction delivered (m.reaction annotation)");

amina.stop(); clinic.stop();
await aminaRun; await clinicRun;
console.log("\nphase2 demo: ALL GREEN");
process.exit(0);
