// phase3.test.mjs — group calls, editing, device sync, state events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatrixLite } from "../packages/matrix-lite/client.js";
import { MemoryStore } from "../packages/matrix-lite/store-memory.js";
import { E2EE } from "../packages/matrix-lite/e2ee.js";
import { GroupCallManager } from "../packages/matrix-lite/group-calls.js";
import { newTransferKey, exportSessions, importSessions } from "../packages/matrix-lite/device-sync.js";

const mkClient = (userId, calls) => new MatrixLite({
  homeserver: "https://hs.ng", accessToken: "t", userId,
  store: new MemoryStore(),
  fetchImpl: async (url, init) => {
    calls?.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ event_id: "$e" }) };
  },
});

test("group call: join publishes m.call.member state and connects to SFU focus", async () => {
  const calls = [];
  const client = mkClient("@amina:hs.ng", calls);
  const focusCreated = [];
  const mgr = new GroupCallManager({
    client,
    focusFactory: { create: async (focus, rtc) => { focusCreated.push({ focus, rtc }); return { close() {} }; } },
    turnServers: [{ urls: "turn:turn.clinic.ng:3478" }],
  });
  const session = await mgr.join("!ward:hs.ng", { type: "livekit", url: "wss://sfu.clinic.ng" });
  assert.equal(session.state, "active");
  assert.equal(focusCreated.length, 1);
  assert.equal(focusCreated[0].rtc.iceServers[0].urls, "turn:turn.clinic.ng:3478");
  const stateCall = calls.find((c) => c.url.includes("/state/m.call.member/"));
  assert.ok(stateCall, "membership state published");
  const body = JSON.parse(stateCall.init.body);
  assert.equal(body.memberships["@amina:hs.ng"].focus.url, "wss://sfu.clinic.ng");
});

test("group call: incoming call in a room surfaces; agreed focus is deterministic", async () => {
  const client = mkClient("@bello:hs.ng", []);
  const mgr = new GroupCallManager({ client, focusFactory: { create: async () => ({}) } });
  let incoming = null;
  mgr.onIncoming = (i) => { incoming = i; };
  client.onStateEvent("!ward:hs.ng", {
    type: "m.call.member", state_key: "@amina:hs.ng",
    content: { memberships: { "@amina:hs.ng": { call_id: "c1", focus: { type: "livekit", url: "wss://a" } } } },
  });
  assert.ok(incoming, "incoming group call surfaced");
  assert.equal(incoming.roomId, "!ward:hs.ng");

  // deterministic focus: lowest userId wins, every participant agrees
  const session = await mgr.join("!ward:hs.ng", { type: "livekit", url: "wss://b" });
  session._updateMembers({
    "@amina:hs.ng": { focus: { type: "livekit", url: "wss://a" } },
    "@bello:hs.ng": { focus: { type: "livekit", url: "wss://b" } },
  });
  assert.equal(session.agreedFocus().url, "wss://a", "amina < bello → her focus wins");
});

test("group call: leave clears membership state and releases the focus", async () => {
  const calls = [];
  const client = mkClient("@amina:hs.ng", calls);
  let closed = false;
  const mgr = new GroupCallManager({ client, focusFactory: { create: async () => ({ close: () => { closed = true; } }) } });
  const s = await mgr.join("!ward:hs.ng", { type: "livekit", url: "wss://sfu" });
  await s.leave();
  assert.equal(s.state, "left");
  assert.ok(closed, "SFU connection released");
  assert.equal(mgr.active, null);
  const last = JSON.parse(calls[calls.length - 1].init.body);
  assert.deepEqual(last.memberships, {}, "membership cleared on leave");
});

test("message edit: m.replace with m.new_content hits the wire", async () => {
  const calls = [];
  const c = mkClient("@a:hs.ng", calls);
  await c.sendEdit("!r:hs.ng", "$orig", "Correction: BP was 118/76");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body["m.relates_to"].rel_type, "m.replace");
  assert.equal(body["m.relates_to"].event_id, "$orig");
  assert.equal(body["m.new_content"].body, "Correction: BP was 118/76");
  assert.match(body.body, /^\* /, "plain fallback carries the edit marker");
});

test("multi-device: sessions move to a new phone sealed by a transfer key", async () => {
  // old phone: two encrypted rooms
  const oldE = new E2EE(new MemoryStore());
  const oldClient = mkClient("@amina:hs.ng", []);
  oldClient.e2ee = oldE;
  for (const room of ["!clinic:hs.ng", "!pharmacy:hs.ng"]) {
    await oldClient.store.setEncrypted(room, true);
    await oldClient.send(room, "history message");
  }
  const key = newTransferKey();
  const payload = await exportSessions(oldE, key);
  assert.ok(!payload.includes("history"), "transfer payload sealed");

  // new phone: import, then send — the ratchet CONTINUES, no re-key storm
  const newE = new E2EE(new MemoryStore());
  const n = await importSessions(newE, key, payload);
  assert.equal(n, 2);
  assert.ok(newE.outbound.has("!clinic:hs.ng"));

  // wrong transfer key must fail closed
  const wrongE = new E2EE(new MemoryStore());
  await assert.rejects(() => importSessions(wrongE, newTransferKey(), payload));
});

test("state events route to onStateEvent, not the message store", async () => {
  const c = mkClient("@me:hs.ng", []);
  const stateEvents = [];
  c.onStateEvent = (r, ev) => stateEvents.push(ev);
  await c._applySync({
    next_batch: "n1",
    rooms: { join: { "!ward:hs.ng": { timeline: { events: [
      { event_id: "$s1", sender: "@x:hs", type: "m.call.member", state_key: "@x:hs",
        content: { memberships: {} } },
    ] } } } },
  });
  assert.equal(stateEvents.length, 1);
  assert.equal(await c.store.hasEvent("$s1"), false, "state events don't pollute the message store");
});
