// otpchannel.test.mjs — OTP delivery channel contract.
import { test } from "node:test";
import assert from "node:assert/strict";

import { OtpChannel, generateCode, OTP_TTL_S }
  from "../packages/otpchannel/otpchannel.js";

const PHONE = "+2348031234567";
const goodProvider = (status = "sent") => ({
  name: "test-sms", send: async () => ({ status }) });

test("no provider: refuses, never pretends", async () => {
  const ch = new OtpChannel({});
  assert.equal(ch.configured(), false);
  await assert.rejects(() => ch.send(PHONE), /refusing to pretend/);
});

test("send + verify round trip; code is one-time", async () => {
  const ch = new OtpChannel({ provider: goodProvider("sent") });
  const { code, status } = await ch.send(PHONE, { rng: () => 0.5 });
  assert.equal(status, "sent");
  assert.equal(code, "555555");
  const ok = await ch.check(PHONE, code);
  assert.equal(ok.ok, true);
  const again = await ch.check(PHONE, code);
  assert.equal(again.ok, false); // one-time
});

test("expiry enforced", async () => {
  const ch = new OtpChannel({ provider: goodProvider() });
  const t0 = 1_000_000;
  const { code } = await ch.send(PHONE, { nowMs: t0 });
  const late = await ch.check(PHONE, code,
    { nowMs: t0 + (OTP_TTL_S + 1) * 1000 });
  assert.equal(late.reason, "expired");
});

test("attempt lockout", async () => {
  const ch = new OtpChannel({ provider: goodProvider() });
  await ch.send(PHONE);
  for (let i = 0; i < 5; i++) {
    const r = await ch.check(PHONE, "000000");
    assert.equal(r.ok, false);
  }
  const r6 = await ch.check(PHONE, "000000");
  assert.equal(r6.reason, "too-many-attempts");
});

test("provider errors and bad statuses raise loudly", async () => {
  const chErr = new OtpChannel({ provider: {
    name: "broken", send: async () => { throw new Error("simdown"); } } });
  await assert.rejects(() => chErr.send(PHONE), /provider error/i);
  const chBad = new OtpChannel({ provider: {
    name: "weird", send: async () => ({ status: "maybe" }) } });
  await assert.rejects(() => chBad.send(PHONE), /unusable status/);
});

test("audit log hashes phone, keeps honest statuses", async () => {
  const ch = new OtpChannel({ provider: goodProvider("queued") });
  await ch.send(PHONE);
  const log = ch.auditLog();
  assert.equal(log[0].outcome, "queued"); // queued ≠ sent
  assert.equal(log[0].phoneHash.length, 64);
  assert.ok(!JSON.stringify(log).includes(PHONE));
});

test("non-E164 refused", async () => {
  const ch = new OtpChannel({ provider: goodProvider() });
  await assert.rejects(() => ch.send("08031234567"), /E\.164/);
});

test("generateCode is 6 digits", () => {
  assert.match(generateCode(), /^\d{6}$/);
});
