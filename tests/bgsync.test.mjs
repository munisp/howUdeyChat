// bgsync.test.mjs — capability honestly detected, battery is a budget,
// the outbox is the only truth drained.
import { test } from "node:test";
import assert from "node:assert/strict";

import { support, BgSyncCoordinator, BGSYNC_VERSION,
         MIN_PERIODIC_INTERVAL_MS } from "../packages/matrix-lite/bg-sync.js";

test("version stamp", () => assert.equal(BGSYNC_VERSION, "bgsync@1.0.0"));

test("capability matrix: detected, not assumed", () => {
  assert.deepEqual(support({}), {
    serviceWorker: false, oneShot: false, periodic: false, foregroundPoll: true });
  const full = support({ serviceWorker: {}, syncManager: {}, periodicSync: {} });
  assert.equal(full.oneShot, true);
  assert.equal(full.periodic, true);
});

test("no service worker: fallback stated, nothing faked", async () => {
  const c = new BgSyncCoordinator({ drain: async () => ({ sent: 0 }) });
  const r = await c.register({});
  assert.equal(r.oneShot, false);
  assert.match(r.notes[0], /foreground poll only, stated/);
});

test("registration reports what actually happened", async () => {
  const calls = [];
  const registration = {
    sync: { register: async tag => calls.push(["sync", tag]) },
    periodicSync: { register: async (tag, opts) => {
      calls.push(["periodic", tag, opts.minInterval]);
      if (opts.minInterval < MIN_PERIODIC_INTERVAL_MS) throw new Error("denied");
    } } };
  const c = new BgSyncCoordinator({ registration, drain: async () => ({ sent: 1 }) });
  const r = await c.register({ serviceWorker: {}, syncManager: {}, periodicSync: {} });
  assert.equal(r.oneShot, true);
  assert.equal(r.periodic, true);
  assert.equal(calls[1][2], MIN_PERIODIC_INTERVAL_MS);
});

test("periodic denial is stated, not retried silently", async () => {
  const registration = {
    sync: { register: async () => {} },
    periodicSync: { register: async () => { throw new Error("denied"); } } };
  const c = new BgSyncCoordinator({ registration, drain: async () => ({}) });
  const r = await c.register({ serviceWorker: {}, syncManager: {}, periodicSync: {} });
  assert.equal(r.periodic, false);
  assert.match(r.notes.join(" "), /denied.*stated/);
});

test("battery budget: over-budget wakes defer with a stated note", async () => {
  let t = Date.parse("2026-11-09T08:00:00Z");
  let drained = 0;
  const c = new BgSyncCoordinator({ wakesPerDay: 2, now: () => t,
    drain: async () => { drained++; return { sent: 3 }; } });
  assert.equal((await c.wake("sw-event")).drained, true);
  assert.equal((await c.wake("workmanager")).drained, true);
  const third = await c.wake("timer");
  assert.equal(third.drained, false);
  assert.match(third.note, /budget spent.*deferred to foreground, stated/);
  assert.equal(drained, 2);
  t = Date.parse("2026-11-10T08:00:00Z");   // budget resets with the day
  assert.equal((await c.wake("timer")).drained, true);
  assert.equal(c.status().budgetRemaining, 1);
});

test("a coordinator without a drain is nothing", () => {
  assert.throws(() => new BgSyncCoordinator({}), /without one it is nothing/);
});
