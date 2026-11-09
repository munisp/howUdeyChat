// d2drelay.test.mjs — opportunistic sync: manifests, anti-entropy,
// checksums, hop horizon, chaos.
import { test } from "node:test";
import assert from "node:assert/strict";

import { D2DStore, D2DSession, wirePair, MAX_HOPS,
         D2D_VERSION } from "../packages/d2drelay/d2drelay.js";

const te = new TextEncoder();

async function storeWith(...texts) {
  const s = new D2DStore();
  for (const t of texts) await s.add(te.encode(t));
  return s;
}

test("version stamp", () => assert.equal(D2D_VERSION, "d2drelay@1.0.0"));

test("store: ids are content hashes; over-size and empties refuse", async () => {
  const s = new D2DStore();
  const id = await s.add(te.encode("vitals: bp 120/80"));
  assert.match(id, /^[0-9a-f]{64}$/);
  await assert.rejects(() => s.add(new Uint8Array(0)), /content-free relay is spam/);
  await assert.rejects(() => s.add(new Uint8Array(600 * 1024)), /not a file server/);
});

test("full exchange: a receives msg-3, b receives msg-1, order-free", async () => {
  const a = await storeWith("msg-1", "msg-2");
  const b = await storeWith("msg-2", "msg-3");
  const [ea, eb] = wirePair();
  const [ra, rb] = await Promise.all([
    new D2DSession(a, ea).run(),
    new D2DSession(b, eb).run(),
  ]);
  assert.equal(ra.received, 1);            // msg-3
  assert.equal(rb.received, 1);            // msg-1
  assert.equal(a.manifest().length, 3);
  assert.equal(b.manifest().length, 3);
  assert.equal(ra.corrupt + rb.corrupt, 0);
});

test("re-meeting the same peer sends nothing new", async () => {
  const a = await storeWith("msg-1");
  const b = await storeWith("msg-1");
  const [ea, eb] = wirePair();
  const [ra, rb] = await Promise.all([
    new D2DSession(a, ea).run(), new D2DSession(b, eb).run()]);
  assert.equal(ra.received + rb.received, 0);
});

test("hop horizon: a rumor beyond the horizon does not travel", async () => {
  const a = new D2DStore();
  const id = await a.add(te.encode("ancient rumor"), MAX_HOPS);   // at the edge
  const b = new D2DStore();
  const [ea, eb] = wirePair();
  const [, rb] = await Promise.all([
    new D2DSession(a, ea).run(), new D2DSession(b, eb).run()]);
  assert.equal(rb.hopLimited, 1);
  assert.equal(rb.received, 0);
  assert.equal(b.manifest().length, 0);
});

test("protocol violations and dead links fail loudly", async () => {
  const a = await storeWith("x");
  const lying = { send: async () => {}, recv: async () => te.encode('{"t":"wrong"}') };
  await assert.rejects(() => new D2DSession(a, lying).run(), /protocol violation/);
  const garbage = { send: async () => {}, recv: async () => te.encode("not json") };
  await assert.rejects(() => new D2DSession(a, garbage).run(), /link is lying or dying/);
});
