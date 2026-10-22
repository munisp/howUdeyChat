// circle-ha-features.test.mjs — refill relay, ladder, roster, digest,
// handover, and the five composite HA rules.
import { test } from "node:test";
import assert from "node:assert/strict";

import { newKey } from "../packages/sign/sign.js";
import { CareCircle } from "../packages/carecircle/circle.js";
import { Ledger } from "../packages/carecircle/ledger.js";
import { RefillRelay } from "../packages/carecircle/refill.js";
import { Ladder } from "../packages/monitor/ladder.js";
import { Roster } from "../packages/carecircle/roster.js";
import { script as digestScript } from "../packages/carecircle/digest.js";
import { closeCircle } from "../packages/carecircle/handover.js";
import { evaluate } from "../packages/monitor/rules.js";
import { translate } from "../packages/monitor/ha_adapter.js";

const key = await newKey();
const NOW = new Date("2026-10-22T12:00:00Z").getTime();
const H = 3600e3, M = 60e3, D = 86400e3;

async function mkCircle() {
  const c = new CareCircle("mama", key);
  await c.invite("adaeze", "receive_results", 86400, NOW);
  await c.invite("chinedu", "reply", 86400, NOW);
  return c;
}

// ---- 1. refill relay ----
test("refill: open -> claim -> collect; fail-closed at every step", async () => {
  const circle = await mkCircle();
  const rr = new RefillRelay(circle);
  rr.open("p1", "metformin 500mg", { daysLeft: 4, now: NOW });
  assert.equal(rr.pending()[0].drug, "metformin 500mg");
  assert.equal((await rr.claim("p1", "stranger", NOW)).reason, "revoked-or-missing");
  assert.equal((await rr.claim("p1", "adaeze", NOW)).ok, true);
  assert.equal((await rr.claim("p1", "chinedu", NOW)).reason, "already-claimed");
  assert.equal((await rr.collect("p1", "chinedu", NOW)).reason, "not-the-claimant");
  assert.equal((await rr.collect("p1", "adaeze", NOW + H)).ok, true);
  assert.equal(rr.pending().length, 0);
  // re-open after collection works; idempotent open updates estimate
  rr.open("p1", "metformin 500mg", { daysLeft: 2, now: NOW + 2 * H });
  assert.equal(rr.pending()[0].days_left, 2);
});

// ---- 2. escalation ladder ----
test("ladder: climbs on silence, stops on signed ack, ends at clinic", async () => {
  const lad = new Ladder(key, [
    { to: "adaeze", ack_window_ms: 30 * M },
    { to: "chinedu", ack_window_ms: 30 * M },
    { to: "clinic" },
  ]);
  lad.start({ kind: "morning-missed" }, NOW);
  assert.equal(lad.current(NOW).to, "adaeze");
  assert.equal((await lad.ack("chinedu", NOW + 5 * M)).reason, "not-your-rung");
  const e1 = await lad.advance(NOW + 31 * M);
  assert.equal(e1.to, "chinedu");
  const e2 = await lad.advance(NOW + 62 * M);
  assert.equal(e2.to, "clinic");
  // fresh ladder: ack at rung 1 stops the climb
  const lad2 = new Ladder(key, [{ to: "adaeze", ack_window_ms: 30 * M }, { to: "clinic" }]);
  lad2.start({ kind: "possible-fall" }, NOW);
  assert.equal((await lad2.ack("adaeze", NOW + 10 * M)).ok, true);
  assert.equal((await lad2.advance(NOW + 40 * M)).escalated, false);
});

// ---- 3. visit roster ----
test("roster: claims, own-release only, coverage gaps flagged", async () => {
  const circle = await mkCircle();
  const ros = new Roster(circle, { max_gap_days: 2 });
  assert.equal((await ros.claim(NOW, "adaeze", NOW)).ok, true);
  assert.equal((await ros.claim(NOW, "chinedu", NOW)).reason, "day-already-claimed");
  assert.equal(ros.release(NOW, "chinedu"), false); // not your claim
  assert.equal((await ros.claim(NOW + 3 * D, "chinedu", NOW)).ok, true);
  const cov = ros.coverage(NOW, 7);
  assert.equal(cov.days.filter((d) => d.claimed_by).length, 2);
  assert.ok(cov.gaps.some((g) => g.length_days >= 2)); // days 1-2 uncovered
});

// ---- 4. voice digest ----
test("digest: alerts first, quiet days honest, pcm supported", () => {
  const names = { adaeze: "Adaeze", chinedu: "Chinedu" };
  const s = digestScript({
    date: "22 October", member: "adaeze", lang: "en", names,
    events: [
      { kind: "expense", member: "chinedu", amount: 3000 },
      { kind: "alert", alert_kind: "missed morning check-in" },
      { kind: "visit", member: "adaeze" },
    ],
  });
  assert.ok(s.indexOf("Attention") < s.indexOf("visited")); // alert precedes visit
  assert.ok(s.includes("Chinedu spent 3000 naira"));
  const q = digestScript({ date: "22 October", member: "chinedu", lang: "pcm", events: [] });
  assert.ok(q.includes("Everywhere calm"));
});

// ---- 5. bereavement / handover ----
test("handover: owner-only, final settlement, all grants revoked, signed receipt", async () => {
  const circle = await mkCircle();
  const led = new Ledger(circle);
  await led.record("adaeze", { kind: "expense", amount: 9000 }, NOW);
  const r1 = await closeCircle({ circle, ledger: led, reason: "deceased",
                                 actorId: "adaeze", now: NOW });
  assert.equal(r1.reason, "only-the-owner-closes");
  const r2 = await closeCircle({ circle, ledger: led, reason: "deceased",
                                 actorId: "mama", now: NOW });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.receipt.revoked_members, ["adaeze", "chinedu"]);
  assert.equal(r2.receipt.final_total_spent, 9000);
  assert.ok(r2.receipt.sig);
  // after closure every access check denies
  assert.equal((await circle.check("adaeze", "receive_results", NOW + H)).allow, false);
  await assert.rejects(
    () => closeCircle({ circle, ledger: led, reason: "mystery", actorId: "mama" }),
    /unknown close reason/);
});

// ---- 6-10. composite HA rules ----
const hb = (at) => ({ type: "heartbeat", entity: "hub_uptime", at });

test("rules: night wandering = motion then door, emergency severity", () => {
  const night = new Date("2026-10-23T02:30:00").getTime();
  const alerts = evaluate([
    hb(night - 10 * M),
    { type: "presence", entity: "hallway_motion", active: true, at: night - 5 * M },
    { type: "presence", entity: "front_door_contact", active: true, at: night - 1 * M },
  ], [], night);
  const w = alerts.find((a) => a.kind === "night-wandering");
  assert.equal(w.severity, "emergency");
});

test("rules: daytime door after motion does NOT fire wandering", () => {
  const day = new Date("2026-10-23T14:00:00").getTime();
  const alerts = evaluate([
    hb(day - 10 * M),
    { type: "presence", entity: "hallway_motion", active: true, at: day - 5 * M },
    { type: "presence", entity: "front_door_contact", active: true, at: day - 1 * M },
  ], [], day);
  assert.equal(alerts.find((a) => a.kind === "night-wandering"), undefined);
});

test("rules: stove on 50min with no kitchen motion = emergency", () => {
  const alerts = evaluate([
    hb(NOW - M),
    { type: "appliance", entity: "stove_plug", active: true, at: NOW - 50 * M },
  ], [], NOW);
  assert.equal(alerts.find((a) => a.kind === "stove-unattended").severity, "emergency");
});

test("rules: possible-fall fires family-severity with honest precision note", () => {
  const alerts = evaluate([
    hb(NOW - M),
    { type: "presence", entity: "bedroom_motion", active: true, at: NOW - 20 * M },
  ], [], NOW);
  const f = alerts.find((a) => a.kind === "possible-fall");
  assert.equal(f.severity, "family");
  assert.ok(f.precision.startsWith("low"));
});

test("rules: hub-offline gates everything — dead hub is not a patient event", () => {
  // no heartbeat for 30 min AND no motion: only hub-offline may fire
  const alerts = evaluate([hb(NOW - 30 * M)], [], NOW);
  assert.deepEqual(alerts.map((a) => a.kind), ["hub-offline"]);
  assert.equal(alerts[0].hub_silence_is_not_patient_silence, true);
});

test("rules: cabinet opened near dose, dose unrecorded past grace = reminder", () => {
  const alerts = evaluate([
    hb(NOW - M),
    { type: "cabinet_open", entity: "med_cabinet", at: NOW - 40 * M },
  ], [{ plan_id: "p1", drug: "amlodipine", due_at: NOW - 45 * M }], NOW);
  const r = alerts.find((a) => a.kind === "dose-unrecorded-after-cabinet");
  assert.equal(r.severity, "reminder");
});

test("adapter emits the new composite signal types", () => {
  assert.equal(translate("homeassistant/switch/stove_plug/state", "on", "mama", NOW).type, "appliance");
  assert.equal(translate("homeassistant/binary_sensor/med_cabinet/state", "ON", "mama", NOW).type, "cabinet_open");
  assert.equal(translate("homeassistant/sensor/hub_uptime/state", "12.4", "mama", NOW).type, "heartbeat");
});
