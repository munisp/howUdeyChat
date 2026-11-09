// deliverysla.test.mjs — stuck messages escalate once; corridor stats
// are floored; the SLA is declared, never assumed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SlaRegistry, DeliveryWatch, K_FLOOR,
         DELIVERYSLA_VERSION } from "../packages/deliverysla/deliverysla.js";

test("version stamp", () => assert.equal(DELIVERYSLA_VERSION, "deliverysla@1.0.0"));

function mkWatch() {
  const registry = new SlaRegistry();
  registry.declare("whatsapp", { deliverWithinMs: 60_000, escalateTo: "sms" });
  registry.declare("sms", { deliverWithinMs: 30_000 });
  let t = 1_000_000;
  const watch = new DeliveryWatch({ registry, now: () => t });
  return { watch, tick: ms => { t += ms; } };
}

test("undeclared lane is untracked — stated", () => {
  const { watch } = mkWatch();
  assert.throws(() => watch.track("r1", "pigeon", "ng"), /undeclared is untracked/);
});

test("stuck-at-sent escalates exactly once, naming everything", () => {
  const { watch, tick } = mkWatch();
  watch.track("r1", "whatsapp", "ng-lagos");
  tick(61_000);
  const esc = watch.sweep();
  assert.equal(esc.length, 1);
  assert.equal(esc[0].escalateTo, "sms");
  assert.match(esc[0].reason, /stuck at "sent".*SLA 60000ms.*stated/);
  assert.equal(watch.sweep().length, 0);   // once, not a nag
});

test("delivery inside the SLA never escalates; stats accumulate", () => {
  const { watch, tick } = mkWatch();
  for (let i = 0; i < 6; i++) watch.track(`r${i}`, "whatsapp", "ng-lagos");
  tick(10_000);
  for (let i = 0; i < 6; i++) watch.update(`r${i}`, "delivered");
  tick(120_000);
  assert.equal(watch.sweep().length, 0);
  const s = watch.stats("ng-lagos");
  assert.equal(s.deliveryRate, 1);
  assert.equal(s.withinSlaRate, 1);
  assert.equal(s.breached, 0);
});

test("backwards status walks refuse", () => {
  const { watch } = mkWatch();
  watch.track("r1", "whatsapp", "ng-lagos");
  watch.update("r1", "delivered");
  assert.throws(() => watch.update("r1", "sent"), /walked backwards/);
  assert.throws(() => watch.update("unknown", "read"), /untracked/);
});

test("stats below the k-floor are suppressed — a rate needs a denominator", () => {
  const { watch } = mkWatch();
  for (let i = 0; i < K_FLOOR - 1; i++) watch.track(`r${i}`, "sms", "cv-santiago");
  const s = watch.stats("cv-santiago");
  assert.equal(s.suppressed, true);
  assert.match(s.reason, /fewer than 5 messages/);
  assert.throws(() => watch.stats("nowhere"), /nothing tracked, stated/);
});

test("breach rate reflects the sweep", () => {
  const { watch, tick } = mkWatch();
  for (let i = 0; i < 5; i++) watch.track(`r${i}`, "whatsapp", "ng-lagos");
  tick(30_000);
  watch.update("r0", "delivered");
  watch.update("r1", "delivered");
  tick(31_000);                       // r2..r4 breach
  watch.sweep();
  const s = watch.stats("ng-lagos");
  assert.equal(s.deliveryRate, 0.4);
  assert.equal(s.breached, 3);
});
