// circle-evolution.test.mjs — kiosk mode, care-load ledger, passive monitor.
import { test } from "node:test";
import assert from "node:assert/strict";

import { newKey } from "../packages/sign/sign.js";
import { CareCircle } from "../packages/carecircle/circle.js";
import { view, checkIn, OK_TAP } from "../packages/kiosk/kiosk.js";
import { Ledger } from "../packages/carecircle/ledger.js";
import { assess } from "../packages/monitor/monitor.js";

const key = await newKey();
const NOW = new Date("2026-10-22T12:00:00").getTime(); // local noon
const H = 3600 * 1000;

async function mkCircle() {
  const c = new CareCircle("mama", key);
  await c.invite("adaeze", "receive_results", 86400, NOW);
  await c.invite("chinedu", "reply", 86400, NOW);
  return c;
}

// ---- kiosk ----
test("kiosk: one screen, three jobs; missed meds are honest", () => {
  const v = view({
    meds: [
      { plan_id: "p1", drug: "amlodipine 5mg", due_at: NOW - 5 * H },            // missed
      { plan_id: "p2", drug: "metformin 500mg", due_at: NOW - 2 * H, recorded_at: NOW - 2 * H }, // taken
      { plan_id: "p3", drug: "artemether", due_at: NOW + 3 * H },                // due later
    ],
    appointments: [{ id: "a1", facility: "Wuse PHC", at: NOW + 26 * H }],
    checkins: [checkIn("mama", NOW - H)],
  }, NOW);
  assert.deepEqual(v.due_meds.map((m) => m.status), ["missed", "taken", "due"]);
  assert.equal(v.missed_count, 1);
  assert.equal(v.next_appointment.facility, "Wuse PHC");
  assert.equal(v.okay.action, OK_TAP);
  assert.ok(v.okay.last_ok_at);
  assert.equal(v.empty, false);
});

test("kiosk: empty schedule says empty; never-checked-in shows null", () => {
  const v = view({}, NOW);
  assert.equal(v.empty, true);
  assert.equal(v.okay.last_ok_at, null);
});

// ---- ledger ----
test("ledger: signed entries, fairness math, minimal settlement", async () => {
  const circle = await mkCircle();
  const led = new Ledger(circle);
  await led.record("adaeze", { kind: "expense", amount: 9000, note: "drugs" }, NOW);
  await led.record("chinedu", { kind: "expense", amount: 3000, note: "transport" }, NOW);
  await led.record("mama", { kind: "visit", hours: 2 }, NOW);
  const rep = await led.report();
  assert.equal(rep.total_spent, 12000);
  // owner is the beneficiary, not a contributor: split is 12000 / 2 members
  assert.equal(rep.fair_share, 6000);
  assert.deepEqual(rep.settlements, [{ from: "chinedu", to: "adaeze", amount: 3000 }]);
  assert.equal(rep.members.mama.visits, 1);
  assert.equal(rep.tampered_dropped, 0);
});

test("ledger: fail-closed — outsiders, unknown kinds, bad expenses rejected", async () => {
  const circle = await mkCircle();
  const led = new Ledger(circle);
  await assert.rejects(() => led.record("stranger", { kind: "visit" }, NOW), /denied/);
  await assert.rejects(() => led.record("adaeze", { kind: "gift" }, NOW), /unknown kind/);
  await assert.rejects(() => led.record("adaeze", { kind: "expense", amount: 0 }, NOW), /positive/);
});

test("ledger: tampered entries are excluded and surfaced", async () => {
  const circle = await mkCircle();
  const led = new Ledger(circle);
  const e = await led.record("adaeze", { kind: "expense", amount: 9000 }, NOW);
  led.entries[0].amount = 1; // tamper after signing
  const rep = await led.report();
  assert.equal(rep.tampered_dropped, 1);
  assert.equal(rep.total_spent, 0); // forged amount never enters the math
  assert.ok(e.sig);
});

// ---- passive monitor ----
test("monitor: silent morning alerts receive_results members + owner only", async () => {
  const members = [
    { id: "mama", role: "owner" },
    { id: "adaeze", scope: "receive_results" },
    { id: "chinedu", scope: "reply" }, // NOT a monitoring recipient
  ];
  const alerts = assess({ checkins: [], meds: [] }, members, NOW);
  assert.equal(alerts[0].kind, "no-data"); // never checked in is itself an alert
  assert.deepEqual(alerts[0].to.sort(), ["adaeze", "mama"]);
});

test("monitor: checked-in morning + on-time meds = quiet", () => {
  const members = [{ id: "mama", role: "owner" }];
  const alerts = assess({
    checkins: [checkIn("mama", NOW - 4 * H)],
    meds: [{ plan_id: "p1", drug: "x", due_at: NOW - H, recorded_at: NOW - H }],
  }, members, NOW);
  assert.deepEqual(alerts, []);
});

test("monitor: overdue med escalates with honest hours; no recipients is loud", () => {
  const members = [{ id: "mama", role: "owner" }];
  const [a] = assess({
    checkins: [checkIn("mama", NOW - 4 * H)],
    meds: [{ plan_id: "p1", drug: "amlodipine", due_at: NOW - 9 * H }],
  }, members, NOW);
  assert.equal(a.kind, "med-overdue");
  assert.equal(a.overdue_hours, 9);
  const none = assess({ checkins: [], meds: [] }, [], NOW);
  assert.equal(none[0].kind, "no-recipients"); // never silently quiet
});
