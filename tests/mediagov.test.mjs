// mediagov.test.mjs — floors veto tiers; budgets state their exhaustion.
import { test } from "node:test";
import assert from "node:assert/strict";

import { govern, DataBudget, MEDIA_CLASSES, TIERS,
         MEDIAGOV_VERSION } from "../packages/mediagov/mediagov.js";

test("version stamp", () => assert.equal(MEDIAGOV_VERSION, "mediagov@1.0.0"));

test("classes and tiers are closed registries", () => {
  assert.throws(() => govern("hologram", "full"), /registry classes only/);
  assert.throws(() => govern("chat-photo", "unlimited"), /full \/ saver \/ ultra/);
  assert.ok(MEDIA_CLASSES["clinical-photo"].floor.minLongEdgePx >= 1600);
});

test("clinical photo on ultra refuses — a blurry wound is a misdiagnosis", () => {
  assert.throws(() => govern("clinical-photo", "ultra"),
    /refusing: wounds, rashes/);
  const plan = govern("clinical-photo", "saver");
  assert.equal(plan.longEdgePx, 1600);
  assert.equal(plan.quality, 70);              // floor raised saver's 60
  assert.equal(plan.floored, true);
});

test("chat photo compresses freely; floor never crossed", () => {
  const plan = govern("chat-photo", "ultra");
  assert.equal(plan.longEdgePx, 800);
  assert.equal(plan.quality, 40);
  assert.equal(plan.floored, false);
});

test("source smaller than the tier cap stays source-sized", () => {
  const plan = govern("chat-photo", "full", { longEdgePx: 1200 });
  assert.equal(plan.longEdgePx, 1200);
});

test("voice notes respect the intelligibility floor", () => {
  const plan = govern("voice-note", "ultra");
  assert.equal(plan.audioBitrateKbps, 16);     // ultra's 12 floored up
  assert.equal(plan.floored, true);
});

test("budget: admits within, queues at exhaustion — stated", () => {
  let day = "2026-11-09";
  const b = new DataBudget({ dailyKb: 1000, now: () => day });
  assert.equal(b.admit("photo", 400).admitted, true);
  assert.equal(b.admit("photo", 400).remainingKb, 200);
  const out = b.admit("photo", 500);
  assert.equal(out.admitted, false);
  assert.match(out.note, /queued for Wi-Fi, stated/);
  assert.equal(b.status().queued, 1);
  day = "2026-11-10";                          // new day, fresh budget
  assert.equal(b.admit("photo", 500).admitted, true);
});

test("wifi bypasses the budget without touching it", () => {
  const b = new DataBudget({ dailyKb: 100 });
  const r = b.admit("video", 99999, { onWifi: true });
  assert.equal(r.admitted, true);
  assert.equal(b.status().spentKb, 0);
});

test("unknown sizes are not admitted; zero budgets refuse", () => {
  const b = new DataBudget({ dailyKb: 100 });
  assert.throws(() => b.admit("photo", -1), /not admitted/);
  assert.throws(() => new DataBudget({ dailyKb: 0 }), /stated in KB/);
});
