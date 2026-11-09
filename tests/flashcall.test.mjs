// flashcall.test.mjs — missed-call verification: the number is the code.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ClipoolRegistry, FlashCallVerifier,
         FLASHCALL_VERSION } from "../packages/flashcall/flashcall.js";

function mkStack(over = {}) {
  const pool = new ClipoolRegistry();
  pool.addRange(["+2347001000001", "+2347001000002", "+2347001009999"]);
  const dialer = over.dialer || (async (to, from) => ({ status: "ringing", from }));
  const v = new FlashCallVerifier({ pool, dialer, rng: () => 0.99, ...over });
  return v;   // rng 0.99 draws the last pool entry ...9999
}

test("version stamp", () => assert.equal(FLASHCALL_VERSION, "flashcall@1.0.0"));

test("no dialer refuses loudly — no pretend flash", async () => {
  const pool = new ClipoolRegistry();
  pool.addRange(["+2347001000001"]);
  const v = new FlashCallVerifier({ pool });
  await assert.rejects(() => v.start("+2348012345678"), /refusing loudly/);
});

test("pool entries are real numbers; empty pool states itself", () => {
  const pool = new ClipoolRegistry();
  assert.throws(() => pool.addRange(["not-a-number"]), /real/);
  assert.throws(() => pool.draw(), /empty CLI pool/);
});

test("happy path: flash rings, user reads back last digits", async () => {
  const v = mkStack();
  const start = await v.start("+2348012345678");
  assert.equal(start.status, "flashing");
  assert.match(start.instruction, /missed call/);
  const res = v.verify("+2348012345678", "9999");
  assert.equal(res.verified, true);
  assert.deepEqual(v.consume("+2348012345678"), { verified: true });
});

test("wrong digits counted; too many guesses burns the session", async () => {
  const v = mkStack();
  await v.start("+2348012345678");
  assert.throws(() => v.verify("+2348012345678", "0000"), /1\/3/);
  assert.throws(() => v.verify("+2348012345678", "0000"), /2\/3/);
  assert.throws(() => v.verify("+2348012345678", "0000"), /3\/3/);
  assert.throws(() => v.verify("+2348012345678", "9999"), /burned/);
});

test("verified is one-shot; expired sessions start over", async () => {
  let t = 1_000_000;
  const v = mkStack({ now: () => t });
  await v.start("+2348012345678");
  v.verify("+2348012345678", "9999");
  assert.throws(() => v.verify("+2348012345678", "9999"), /one-shot/);

  const v2 = mkStack({ now: () => t });
  await v2.start("+2348022345678");
  t += 6 * 60 * 1000;
  assert.throws(() => v2.verify("+2348022345678", "9999"), /expired.*start over/);
});

test("dialer must confirm the flash — ambiguity is stated", async () => {
  const v = mkStack({ dialer: async () => ({ status: "maybe" }) });
  await assert.rejects(() => v.start("+2348012345678"), /did not confirm.*stated/);
});
