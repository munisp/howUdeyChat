// power-budget.test.mjs — battery & memory budgets (ADR-0012).
// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MatrixLite, SYNC_TIMEOUT_MS, SYNC_TIMEOUT_MAX_MS, UNDECRYPTABLE_CAP,
} from "../packages/matrix-lite/client.js";
import { MemoryStore } from "../packages/matrix-lite/store-memory.js";
import { enforceBudget } from "../packages/matrix-lite/media.js";

function scriptedFetch(queue) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift() || { status: 500, json: {} };
    if (next.throw) throw new Error(next.throw);
    return { ok: next.status < 300, status: next.status, json: async () => next.json };
  };
  return { f, calls };
}

const cfg = (fetchImpl, store) => ({
  homeserver: "http://hs", accessToken: "t", userId: "@p:hs", store, fetchImpl,
});

const emptySync = (n) => ({ status: 200, json: { next_batch: `s${n}`, rooms: { join: {} } } });
const eventSync = (n, id) => ({
  status: 200,
  json: {
    next_batch: `s${n}`,
    rooms: { join: { "!r:hs": { timeline: { events: [
      { event_id: id, type: "m.room.message", sender: "@doc:hs", content: { body: "hi" } },
    ] } } } },
  },
});

test("background mode short-polls (timeout=0) instead of holding the radio open", async () => {
  const { f, calls } = scriptedFetch([emptySync(1), emptySync(2), emptySync(3)]);
  const client = new MatrixLite(cfg(f, new MemoryStore()));
  client.setBackground(true);
  const origSleep = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => origSleep(fn, 0); // compress BACKGROUND_POLL_MS
  try {
    client.start();
    await new Promise((r) => origSleep(r, 50));
    client.stop();
  } finally {
    globalThis.setTimeout = origSleep;
  }
  assert.ok(calls.length >= 2, "should have polled");
  for (const c of calls) assert.match(c.url, /timeout=0/, `background poll must not long-poll: ${c.url}`);
});

test("idle foreground syncs grow the long-poll timeout up to the cap", async () => {
  const queue = Array.from({ length: 8 }, (_, i) => emptySync(i));
  const { f, calls } = scriptedFetch(queue);
  const client = new MatrixLite(cfg(f, new MemoryStore()));
  client.start();
  await new Promise((r) => setTimeout(r, 80));
  client.stop();
  const timeouts = calls.map((c) => +/timeout=(\d+)/.exec(c.url)[1]);
  assert.equal(timeouts[0], SYNC_TIMEOUT_MS);
  assert.ok(timeouts[1] > timeouts[0], "idle growth");
  assert.ok(Math.max(...timeouts) <= SYNC_TIMEOUT_MAX_MS, "never past the cap");
});

test("activity resets the idle timeout to the foreground default", async () => {
  const queue = [emptySync(1), emptySync(2), eventSync(3, "$e1"), emptySync(4)];
  const { f, calls } = scriptedFetch(queue);
  const client = new MatrixLite(cfg(f, new MemoryStore()));
  client.start();
  await new Promise((r) => setTimeout(r, 80));
  client.stop();
  const timeouts = calls.map((c) => +/timeout=(\d+)/.exec(c.url)[1]);
  assert.equal(timeouts[3], SYNC_TIMEOUT_MS, "after activity, timeout resets");
});

test("memory budget: pruneEvents keeps only the newest N per room", async () => {
  const store = new MemoryStore();
  for (let i = 0; i < 10; i++) {
    await store.putEvent("!r:hs", { event_id: `$e${i}`, origin_server_ts: i, type: "m.room.message" });
  }
  const dropped = await store.pruneEvents("!r:hs", 3);
  assert.equal(dropped, 7);
  const left = await store.roomEvents("!r:hs");
  assert.deepEqual(left.map((e) => e.event_id), ["$e7", "$e8", "$e9"]);
  assert.equal(await store.pruneEvents("!r:hs", 3), 0, "second prune is a no-op");
});

test("undecryptable map is bounded (no ciphertext leak)", async () => {
  const store = new MemoryStore();
  const queue = [];
  const room = { timeline: { events: [] } };
  for (let i = 0; i < UNDECRYPTABLE_CAP + 50; i++) {
    room.timeline.events.push({
      event_id: `$x${i}`, type: "m.room.encrypted", sender: "@doc:hs", content: { bogus: i },
    });
  }
  queue.push({ status: 200, json: { next_batch: "s1", rooms: { join: { "!r:hs": room } } } });
  const { f } = scriptedFetch(queue);
  const e2ee = { decryptEvent: async () => { throw new Error("no key"); }, acceptRoomKey: async () => {} };
  const client = new MatrixLite({ ...cfg(f, store), e2ee });
  await client._applySync(queue[0].json);
  assert.equal(client._undecryptable.size, UNDECRYPTABLE_CAP, "map capped");
});

test("media LRU budget evicts oldest and respects the cap", async () => {
  const store = new MemoryStore();
  const blob = (kb) => ({ size: kb * 1024 });
  await store.mediaPut("mxc://a/1", blob(30), "image/jpeg");
  await new Promise((r) => setTimeout(r, 2));
  await store.mediaPut("mxc://a/2", blob(30), "image/jpeg");
  await new Promise((r) => setTimeout(r, 2));
  await store.mediaPut("mxc://a/3", blob(30), "image/jpeg");
  // touch a/1 so a/2 is now oldest
  await store.mediaGet("mxc://a/1");

  const res = await enforceBudget(store, 60 * 1024);
  assert.equal(res.evicted, 1, "one eviction fits the cap");
  assert.ok(await store.mediaGet("mxc://a/1"), "recently used survives");
  assert.ok(!(await store.mediaList()).find((e) => e.mxc === "mxc://a/2"), "oldest evicted");
});

test("media budget no-op when under the cap", async () => {
  const store = new MemoryStore();
  await store.mediaPut("mxc://a/1", { size: 100 }, "image/jpeg");
  const res = await enforceBudget(store, 1024);
  assert.deepEqual(res, { evicted: 0, freedBytes: 0 });
});
