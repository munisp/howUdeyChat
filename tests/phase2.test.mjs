// phase2.test.mjs — E2EE, calls, social semantics. node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatrixLite } from "../packages/matrix-lite/client.js";
import { MemoryStore } from "../packages/matrix-lite/store-memory.js";
import { E2EE, InboundSession, GroupSession } from "../packages/matrix-lite/e2ee.js";
import { CallManager } from "../packages/matrix-lite/calls.js";

const mkClient = (userId, store, fetchImpl) =>
  new MatrixLite({ homeserver: "https://hs.ng", accessToken: "t", userId, store: store || new MemoryStore(), fetchImpl });

const okFetch = (calls) => async (url, init) => {
  calls?.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ event_id: "$e" }) };
};

test("e2ee: encrypt → share key → decrypt roundtrip between two clients", async () => {
  // amina sends; clinic receives the m.room_key and reads the message
  const aminaE = new E2EE(new MemoryStore());
  const amina = mkClient("@amina:hs.ng", undefined, okFetch());
  amina.e2ee = aminaE;
  await amina.enableEncryption("!r:hs.ng");
  const calls = [];
  amina.fetch = okFetch(calls);
  await amina.send("!r:hs.ng", "Your BP reading looks good");

  // outbox flushed: first call = key share (sendToDevice), second = message
  const keyShareCall = calls.find((c) => c.url.includes("sendToDevice/m.room_key"));
  const msgCall = calls.find((c) => c.url.includes("/send/m.room.encrypted/"));
  assert.ok(keyShareCall, "room key shared via to-device");
  assert.ok(msgCall, "wire carries m.room.encrypted");
  const wireBody = JSON.parse(msgCall.init.body);
  assert.equal(wireBody.algorithm, "ng.huc.megolm.v1");
  assert.ok(!JSON.stringify(wireBody).includes("BP reading"), "no plaintext on the wire");

  // clinic side: accept the shared key, decrypt the event
  const clinicE = new E2EE(new MemoryStore());
  const share = JSON.parse(keyShareCall.init.body).messages["*"]["*"];
  await clinicE.acceptRoomKey(share);
  const plain = await clinicE.decryptEvent(wireBody);
  assert.equal(plain.body, "Your BP reading looks good");
});

test("e2ee: ratchet gives forward secrecy + tamper fails closed", async () => {
  const s = await GroupSession.create();
  const share = s.exportRatchet(); // index 0
  const m1 = await s.encrypt({ body: "first" });
  const m2 = await s.encrypt({ body: "second" });
  assert.equal(m1.index, 0);
  assert.equal(m2.index, 1);
  assert.notDeepEqual(m1.ciphertext, m2.ciphertext);

  const inbound = InboundSession.fromRatchet(share);
  // out-of-order delivery still decrypts (bounded walk-forward)
  assert.equal((await inbound.decrypt(m2)).body, "second");
  assert.equal((await inbound.decrypt(m1)).body, "first");
  // tamper: flip a ciphertext byte → AES-GCM auth failure
  const bad = { ...m2, ciphertext: m2.ciphertext.slice(0, -4) + "AAAA" };
  await assert.rejects(() => inbound.decrypt(bad));
});

test("e2ee: outbox never holds cleartext in encrypted rooms", async () => {
  const store = new MemoryStore();
  const c = mkClient("@a:hs", store, okFetch());
  c.e2ee = new E2EE(store);
  await c.enableEncryption("!r:hs");
  // simulate dead link so the message STAYS in the outbox
  c.fetch = async () => { throw new Error("down"); };
  await c.send("!r:hs", "secret symptoms");
  const queued = await store.outboxAll();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "m.room.encrypted");
  assert.ok(!JSON.stringify(queued[0]).includes("secret symptoms"),
    "queue holds ciphertext only");
});

test("calls: outgoing invite → answer → connected; hangup ends", async () => {
  const calls = [];
  const fakePc = (() => {
    return {
      added: [], local: null, remote: null, closed: false,
      addTrack(t) { this.added.push(t); },
      async createOffer() { return { type: "offer", sdp: "OFFER-SDP" }; },
      async createAnswer() { return { type: "answer", sdp: "ANSWER-SDP" }; },
      async setLocalDescription(d) { this.local = d; },
      async setRemoteDescription(d) { this.remote = d; },
      async addIceCandidate() {},
      close() { this.closed = true; },
    };
  });
  const rtc = {
    createPeer: () => fakePc(),
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
  };
  const client = mkClient("@amina:hs.ng", undefined, okFetch(calls));
  const mgr = new CallManager({ client, rtc, turnServers: [{ urls: "turn:turn.clinic.ng:3478" }] });

  const session = await mgr.placeCall("!r:hs.ng", { video: false });
  assert.equal(session.state, "inviting");
  const invite = calls.find((c) => c.url.includes("/send/m.call.invite/"));
  assert.ok(invite);
  assert.match(JSON.parse(invite.init.body).offer.sdp, /OFFER-SDP/);

  // clinic answers
  await session._handle("m.call.answer", { call_id: session.callId, answer: { type: "answer", sdp: "ANSWER-SDP" } });
  assert.equal(session.state, "connected");

  await session.hangup();
  assert.equal(session.state, "ended");
  assert.ok(calls.some((c) => c.url.includes("/send/m.call.hangup/")));
  assert.equal(mgr.call, null);
});

test("calls: incoming invite rings; answer sends SDP answer", async () => {
  const calls = [];
  const rtc = {
    createPeer: () => ({
      addTrack() {}, async setRemoteDescription() {}, async setLocalDescription() {},
      async createAnswer() { return { sdp: "ANSWER-SDP" }; }, async addIceCandidate() {}, close() {},
    }),
    getUserMedia: async () => ({ getTracks: () => [] }),
  };
  const client = mkClient("@clinic:hs.ng", undefined, okFetch(calls));
  const mgr = new CallManager({ client, rtc });
  let incoming = null;
  mgr.onIncoming = (s) => { incoming = s; };
  client.onCallEvent("!r:hs.ng", {
    type: "m.call.invite", sender: "@amina:hs.ng",
    content: { call_id: "c1", offer: { type: "offer", sdp: "OFFER-SDP" } },
  });
  assert.ok(incoming, "incoming call surfaced");
  const sess = mgr.call;
  await sess.answer({ video: false });
  assert.equal(sess.state, "connected");
  const ans = calls.find((c) => c.url.includes("/send/m.call.answer/"));
  assert.match(JSON.parse(ans.init.body).answer.sdp, /ANSWER-SDP/);
});

test("social: reaction, redaction, read receipt, typing hit the right endpoints", async () => {
  const calls = [];
  const c = mkClient("@a:hs.ng", undefined, okFetch(calls));
  await c.sendReaction("!r:hs", "$e1", "👍");
  await c.redact("!r:hs", "$e1", "sent in error");
  await c.sendReadReceipt("!r:hs", "$e1");
  await c.sendTyping("!r:hs", true);
  const urls = calls.map((x) => decodeURIComponent(x.url));
  assert.ok(urls.some((u) => u.includes("/send/m.reaction/")));
  assert.ok(urls.some((u) => u.includes("/redact/$e1/")));
  assert.ok(urls.some((u) => u.includes("/receipt/m.read/$e1")));
  assert.ok(urls.some((u) => u.includes("/typing/@a:hs.ng")));
  const reaction = JSON.parse(calls[0].init.body);
  assert.equal(reaction["m.relates_to"].key, "👍");
});

test("sync: call events route to onCallEvent, reactions stored", async () => {
  const store = new MemoryStore();
  const c = mkClient("@me:hs", store, okFetch([]));
  const callEvents = [];
  c.onCallEvent = (r, ev) => callEvents.push(ev);
  await c._applySync({
    next_batch: "n1",
    rooms: { join: { "!r:hs": { timeline: { events: [
      { event_id: "$m1", sender: "@x:hs", type: "m.room.message", content: { msgtype: "m.text", body: "hi" } },
      { event_id: "$r1", sender: "@x:hs", type: "m.reaction", content: { "m.relates_to": { key: "❤️", event_id: "$m1" } } },
      { event_id: "$c1", sender: "@x:hs", type: "m.call.invite", content: { call_id: "k", offer: {} } },
    ] } } } },
  });
  assert.ok(await store.hasEvent("$m1"));
  assert.ok(await store.hasEvent("$r1"), "reaction stored");
  assert.equal(callEvents.length, 1);
  assert.equal(callEvents[0].type, "m.call.invite");
});
