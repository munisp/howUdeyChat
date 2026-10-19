// demo/offline-chat.mjs — drive matrix-lite against the simulated network.
// Scenario: patient goes offline mid-conversation (messages queue), the
// clinic sends text + x-ray + voice note + appointment artifact, the link
// recovers, everything lands; media resolves once and caches offline.
import { MatrixLite } from "../packages/matrix-lite/client.js";
import { MemoryStore } from "../packages/matrix-lite/store-memory.js";
import { downloadCached, classify, parseGeo } from "../packages/matrix-lite/media.js";
import { setLang, t } from "../apps/pwa/js/i18n.js";
import { writeFileSync } from "node:fs";

const HS = "http://127.0.0.1:18420";
const phase = (p) => writeFileSync("/tmp/huc-phase", p);
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`ok: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = new MemoryStore();
const received = [];
const states = [];
const client = new MatrixLite({ homeserver: HS, accessToken: "demo", userId: "@amina:hs.demo", store });
client.onEvent = (room, ev) => received.push(ev);
client.onSyncState = (s) => { if (states[states.length - 1] !== s) states.push(s); };

phase("up");
const running = client.start();
await sleep(800);

// 1. clinic's four rich messages arrive while link is up
if (received.length !== 4) fail(`want 4 inbound events, got ${received.length}`);
const kinds = received.map((e) => classify(e.content));
if (kinds.join(",") !== "text,image,audio,artifact:appointment") fail(`bad kinds: ${kinds}`);
ok("rich inbound: text + image + audio + appointment artifact");

// 2. media: fetch x-ray once (network), then again — second hit must be cache
const ctx = { homeserver: HS, token: "demo", store };
const a = await downloadCached(ctx, "mxc://hs.demo/xray1");
if (a.mime !== "image/png") fail("x-ray mime");
const before = (await store.mediaGet("mxc://hs.demo/xray1")) !== undefined;
phase("down");
await sleep(200);
const b = await downloadCached(ctx, "mxc://hs.demo/xray1"); // link dead, cache serves
if (!before || b.mime !== "image/png") fail("offline media cache");
ok("media cache: x-ray opens offline after one download");

// 3. patient replies while the link is DOWN — must queue, not fail
const txn = await client.send("!clinic:hs.demo", "Na the x-ray be this? E clear well well.");
const queued = await store.outboxAll();
if (queued.length !== 1 || queued[0].txnId !== txn) fail("offline outbox queue");
ok("offline send queued durably (airplane-mode safe)");

// 4. patient shares her location from the farm — also queued
await client.sendContent("!clinic:hs.demo", {
  msgtype: "m.location", body: "I dey farm", geo_uri: "geo:10.3104,7.6233;u=25",
});
if ((await store.outboxAll()).length !== 2) fail("location queued");
ok("location share queued (geo:10.31,7.62)");

// 5. link recovers → outbox drains in order
phase("up");
let sent = [];
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const res = await fetch(`${HS}/control/sent`);
  sent = (await res.json()).sent;
  if (sent.length >= 2) break;
}
if (sent.length !== 2) fail(`want 2 delivered, got ${sent.length}`);
if (sent[0].msgtype !== "m.text" || sent[1].msgtype !== "m.location") fail("delivery order/types");
if ((await store.outboxAll()).length !== 0) fail("outbox not drained");
ok("recovery: outbox drained in order (text, then location)");

// 6. appointment artifact carries a parseable facility pin
const appt = received[3].content["ng.openhealth"];
if (appt.lat !== 10.5203 || appt.lon !== 7.4401) fail("artifact pin");
ok("appointment artifact carries facility pin (map-ready)");

// 7. i18n: the app speaks all five languages off the same data
setLang("ha");
if (!t("status_offline").includes("haya")) fail("Hausa status");
setLang("pcm");
if (!t("send").includes("Send am")) fail("Pidgin send");
ok("i18n: Hausa + Pidgin strings live");

client.stop();
await running;
console.log("\noffline-chat demo: ALL GREEN");
process.exit(0);
