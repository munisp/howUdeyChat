// phase7.test.mjs — patient-channel innovations (ADR-0013):
// actionable artifacts, consent gate, triage, adherence loops, verified
// staff badges, care circles, campaigns, shredder, bulletins.
import { test } from "node:test";
import assert from "node:assert/strict";

import { newKey } from "../packages/sign/sign.js";
import { buildAction, intakeAction } from "../packages/artifacts/actions.js";
import { issueGrant, canDeliver } from "../packages/consent-gate/gate.js";
import { Triage } from "../packages/triage/triage.js";
import { Adherence } from "../packages/adherence/adherence.js";
import { issueBadge, badgeQR, verifyBadge } from "../packages/verify/verify.js";
import { CareCircle } from "../packages/carecircle/circle.js";
import { Campaign } from "../packages/broadcast/campaign.js";
import { Shredder } from "../packages/shredder/shredder.js";
import { issueBulletin, BulletinBoard } from "../packages/bulletin/bulletin.js";

const key = await newKey();

test("actions: one-tap appointment confirm is signed, applied, and replay-safe", async () => {
  const seen = new Map();
  const env = await buildAction({ kind: "appointment.confirm", refId: "appt-1", actor: "@amina:hs.ng" }, key);
  const first = await intakeAction(env, key, seen);
  assert.equal(first.applied, true);
  const replay = await intakeAction(env, key, seen);
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, "duplicate");
  const forged = { ...env, action: { ...env.action, choice: "cancel" } };
  assert.equal((await intakeAction(forged, key, new Map())).reason, "bad-signature");
  await assert.rejects(() => buildAction({ kind: "wire.money", refId: "x", actor: "a" }, key));
});

test("consent gate: no grant / expired / wrong scope all deny; valid grant allows", async () => {
  const grant = await issueGrant({ patient: "@amina:hs.ng", contactId: "@dr.eze:hs.ng", scope: "chat", ttlSeconds: 3600 }, key);
  assert.deepEqual(await canDeliver(grant, { contactId: "@dr.eze:hs.ng", scope: "chat" }, key), { allow: true });
  assert.equal((await canDeliver(grant, { contactId: "@dr.eze:hs.ng", scope: "results" }, key)).reason, "out-of-scope");
  assert.equal((await canDeliver(grant, { contactId: "@fraud:hs.ng", scope: "chat" }, key)).reason, "wrong-contact");
  const expired = await issueGrant({ patient: "@a", contactId: "@d", scope: "chat", ttlSeconds: 10 }, key, 0);
  assert.equal((await canDeliver(expired, { contactId: "@d", scope: "chat" }, key, 11_000)).reason, "expired");
  const tampered = { ...grant, scope: "results" };
  assert.equal((await canDeliver(tampered, { contactId: "@dr.eze:hs.ng", scope: "results" }, key)).reason, "tampered");
  assert.equal((await canDeliver(null, { contactId: "@d", scope: "chat" }, key)).allow, false);
});

test("triage: pregnancy red flag escalates immediately; benign fever routes routine", () => {
  const t1 = new Triage("pregnancy", "pcm");
  const q = t1.question();
  assert.match(q.text, /Blood dey come/);
  const res = t1.answer("yes");
  assert.equal(res.done, true);
  assert.equal(res.escalate, true);
  assert.equal(res.outcome.level, "critical");

  const t2 = new Triage("fever", "en");
  t2.answer("lt3");
  const res2 = t2.answer("no");
  assert.equal(res2.outcome.name, "routine");
  assert.equal(res2.escalate, false);
  assert.throws(() => new Triage("astrology"));
});

test("adherence: due doses, late honesty, score, and lakefeed-shaped event", () => {
  const clock = { t: 1_000_000 };
  const ad = new Adherence(() => clock.t);
  ad.schedule("plan-1", "ref-882", [
    { id: "d1", dueAt: 1_000_000, label: "ART morning" },
    { id: "d2", dueAt: 1_043_200_000, label: "ART evening" },
  ]);
  assert.equal(ad.due("plan-1").length, 1);
  ad.record("d1", "taken");
  clock.t = 1_043_200_000 + 5 * 3600 * 1000; // 5h late
  const late = ad.record("d2", "taken");
  assert.equal(late.status, "late");
  assert.equal(ad.score("plan-1"), 0.5);
  assert.equal(ad.record("d1", "taken").reason, "duplicate");
  const ev = ad.toRegistryEvent("plan-1", "OHF-FC-AMC-0001");
  assert.equal(ev.event_type, "adherence_snapshot");
  assert.equal(ev.patient_ref, "ref-882");
  assert.equal(ev.payload.score, 0.5);
});

test("verify: staff badge verifies offline; QR round-trips; tamper and expiry fail closed", async () => {
  const badge = await issueBadge({ staffId: "s1", name: "Dr. Eze", council: "MDCN", licence: "MDCN-12345" }, key);
  assert.equal((await verifyBadge(badge, key)).verified, true);
  const qr = badgeQR(badge);
  assert.match(qr, /^HUC1\./);
  const back = await verifyBadge(qr, key);
  assert.equal(back.verified, true);
  assert.equal(back.badge.licence, "MDCN-12345");
  assert.equal((await verifyBadge({ ...badge, name: "Dr. Fraud" }, key)).reason, "tampered");
  const old = await issueBadge({ staffId: "s2", name: "X", council: "PCN", licence: "L", ttlDays: 1 }, key, 0);
  assert.equal((await verifyBadge(old, key, 2 * 86400 * 1000)).reason, "expired");
  assert.equal((await verifyBadge("HUC1.garbage", key)).reason, "malformed");
});

test("care circle: scoped expiring proxy access; members cannot re-invite; revocation sticks", async () => {
  const circle = new CareCircle("@mama:hs.ng", key);
  await circle.invite("@daughter:hs.ng", "read", 86400);
  assert.equal((await circle.check("@daughter:hs.ng", "read")).allow, true);
  assert.equal((await circle.check("@daughter:hs.ng", "receive_results")).reason, "out-of-scope");
  assert.equal(circle.canInvite("@daughter:hs.ng"), false); // one level only
  assert.equal(circle.canInvite("@mama:hs.ng"), true);
  circle.revoke("@daughter:hs.ng");
  assert.equal((await circle.check("@daughter:hs.ng", "read")).reason, "revoked-or-missing");
  await assert.rejects(() => circle.invite("@son:hs.ng", "administer", 100));
});

test("campaign: cohort targeting honours consent; quiet hours block non-emergency sends", () => {
  const members = [
    { id: "p1", facility: "OHF-FC-AMC-0001", lga: "amc", tag: "u5", consent: "campaign" },
    { id: "p2", facility: "OHF-FC-AMC-0001", lga: "amc", tag: "u5", consent: "chat" },
    { id: "p3", facility: "OHF-LA-IKE-0007", lga: "ikeja", tag: "u5", consent: "campaign" },
  ];
  const c = new Campaign({ id: "measles-w1", cohort: { lga: "amc", tag: "u5" }, body: "Measles catch-up Saturday" });
  assert.deepEqual(c.target(members).map((m) => m.id), ["p1"]);
  assert.equal(c.sendWindowOk(new Date("2026-01-01T23:00:00")), false);
  assert.equal(c.sendWindowOk(new Date("2026-01-01T12:00:00")), true);
  const e = new Campaign({ id: "cholera", body: "Boil water", kind: "emergency" });
  assert.equal(e.sendWindowOk(new Date("2026-01-01T23:00:00")), true);
  c.record("sent"); c.record("sent"); c.record("delivered"); c.record("read");
  assert.equal(c.report().delivery_rate, 0.5); // 1 of 2 sent delivered — honest tally
});

test("shredder: TTL sweep removes expired messages with content-free audit; panic wipe clears all", async () => {
  const data = new Map([
    ["m1", { id: "m1", ts: 0 }], ["m2", { id: "m2", ts: 8000 }], ["m3", { id: "m3", ts: 0 }],
  ]);
  const store = {
    list: async (t) => (t === "th1" ? [data.get("m1"), data.get("m2")] : [data.get("m3")]).filter(Boolean),
    delete: async (id) => data.delete(id),
  };
  const sh = new Shredder(store, () => 10_000);
  sh.register("th1", { ttlSeconds: 4 });  // m1 expired, m2 alive
  sh.register("th2", { ttlSeconds: 60 }); // m3 alive
  const written = await sh.sweep();
  assert.equal(written.length, 1);
  assert.equal(written[0].removed, 1);
  assert.equal(data.has("m1"), false);
  assert.equal(data.has("m2"), true);
  assert.ok(!("body" in written[0]), "audit never carries content");
  const panic = await sh.panicWipe();
  assert.equal(panic.removed, 2);
  assert.equal(data.size, 0);
});

test("bulletin: signed notices render offline; forged and expired never display", async () => {
  const board = new BulletinBoard(key);
  const b1 = await issueBulletin({ id: "n1", facility: "OHF-FC-AMC-0001", kind: "stock", body: "Antimalarials back in stock" }, key);
  assert.equal((await board.add(b1)).stored, true);
  const forged = { ...b1, body: "Free surgery Sunday, call 0800SCAM" };
  assert.equal((await board.add(forged)).reason, "tampered");
  const stale = await issueBulletin({ id: "n2", facility: "F", kind: "hours", body: "old", validDays: 1 }, key, 0);
  assert.equal((await board.add(stale)).reason, "expired");
  await assert.rejects(() => issueBulletin({ id: "n3", facility: "F", kind: "rumor", body: "x" }, key));
  const list = board.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "stock");
});
