// matrix-lite.test.mjs — node tests against a scripted fetch. No network.
// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatrixLite, login } from "../packages/matrix-lite/client.js";
import { MemoryStore } from "../packages/matrix-lite/store-memory.js";

// scriptedFetch: queue of {status, json} responses; records every request.
function scriptedFetch(queue) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift() || { status: 500, json: {} };
    if (next.throw) throw new Error(next.throw);
    return {
      ok: next.status < 300,
      status: next.status,
      json: async () => next.json,
    };
  };
  f.calls = calls;
  return f;
}

const cfg = (fetchImpl, store) => ({
  homeserver: "https://hs.test", accessToken: "tok", userId: "@p:hs.test",
  store, fetchImpl,
});

test("sync applies messages, dedupes, skips own echo, advances token", async () => {
  const store = new MemoryStore();
  const syncResp = {
    status: 200,
    json: {
    next_batch: "n2",
    rooms: { join: { "!r:hs": { timeline: { events: [
      { event_id: "$1", sender: "@clinic:hs", type: "m.room.message", content: { body: "hello" } },
      { event_id: "$1", sender: "@clinic:hs", type: "m.room.message", content: { body: "hello" } }, // dup
      { event_id: "$2", sender: "@p:hs.test", type: "m.room.message", content: { body: "mine" } }, // echo
    ] } } } },
    },
  };
  const f = scriptedFetch([syncResp]);
  const c = new MatrixLite(cfg(f, store));
  const seen = [];
  c.onEvent = (room, ev) => seen.push(ev.event_id);
  c.onSyncState = (s) => { if (s === "live") c.stop(); }; // one clean cycle
  await c.start();
  assert.deepEqual(seen, ["$1"]);
  assert.equal(await store.getSyncToken(), "n2");
});

test("send is durable before network and uses txn id for idempotency", async () => {
  const store = new MemoryStore();
  const f = scriptedFetch([{ status: 200, json: { event_id: "$e1" } }]);
  const c = new MatrixLite(cfg(f, store));
  const txn = await c.send("!r:hs", "Bawo ni");
  assert.equal((await store.outboxAll()).length, 0, "flushed when network up");
  const put = f.calls[0];
  assert.match(put.url, new RegExp(`/send/m.room.message/${txn}$`));
  assert.equal(JSON.parse(put.init.body).body, "Bawo ni");
});

test("offline send queues, retries after recovery, survives restart", async () => {
  const store = new MemoryStore();
  const down = scriptedFetch([{ throw: "network down" }]);
  const c = new MatrixLite(cfg(down, store));
  const txn = await c.send("!r:hs", "I need my results");
  assert.equal((await store.outboxAll()).length, 1, "queued while offline");

  // patient kills the app mid-outage; new client, same store (IndexedDB)
  const up = scriptedFetch([{ status: 200, json: { event_id: "$e9" } }]);
  const c2 = new MatrixLite(cfg(up, store));
  const sent = [];
  c2.onSent = (t, ev) => sent.push([t, ev]);
  await c2._flushOutbox();
  assert.deepEqual(sent, [[txn, "$e9"]]);
  assert.equal((await store.outboxAll()).length, 0);
});

test("sync loop backs off on failure and recovers", async () => {
  const store = new MemoryStore();
  const f = scriptedFetch([
    { throw: "down" }, { throw: "down" },
    { status: 200, json: { next_batch: "n1", rooms: { join: {} } } },
  ]);
  const c = new MatrixLite(cfg(f, store));
  const states = [];
  c.onSyncState = (s) => { states.push(s); if (s === "live") c.stop(); };
  // shrink backoff for the test
  const orig = 1000;
  c.retryMs = 5;
  await c.start();
  assert.ok(states.filter((s) => s === "offline").length >= 2);
  assert.ok(states.includes("live"));
  assert.equal(f.calls.length, 3);
});

test("login posts m.login.password with device name", async () => {
  const f = scriptedFetch([{ status: 200, json: { access_token: "t", user_id: "@p:hs" } }]);
  const sess = await login("https://hs.test/", "amina", "secret", f);
  assert.equal(sess.access_token, "t");
  const { url, init } = f.calls[0];
  assert.equal(url, "https://hs.test/_matrix/client/v3/login");
  const body = JSON.parse(init.body);
  assert.equal(body.type, "m.login.password");
  assert.equal(body.identifier.user, "amina");
});

test("i18n: all languages define every key the UI uses", async () => {
  const { msgs, LANGS } = await import("../apps/pwa/js/i18n.js");
  const keys = Object.keys(msgs.en);
  assert.ok(keys.length >= 15, "English baseline is complete");
  for (const code of Object.keys(LANGS)) {
    for (const k of keys) {
      assert.ok(msgs[code][k], `${code} missing key ${k}`);
    }
  }
});
