// identity.test.mjs — phone identity + private discovery contract.
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizePhone, IdentityDirectory }
  from "../packages/identity/identity.js";

const SALT = new TextEncoder().encode("test-deployment-salt-32bytes!!!");

function mkDir(issuer) {
  return new IdentityDirectory({
    salt: SALT, otpIssuer: issuer || (async () => "123456"),
  });
}

test("normalizePhone: nigerian local, 00 prefix, junk refused", () => {
  assert.equal(normalizePhone("0803 123 4567"), "+2348031234567");
  assert.equal(normalizePhone("002348031234567"), "+2348031234567");
  assert.equal(normalizePhone("+234 803-123-4567"), "+2348031234567");
  assert.equal(normalizePhone("123"), null);
  assert.equal(normalizePhone(123), null);
});

test("registration requires verification — fail closed", async () => {
  const d = mkDir();
  await d.register("u1", "08031234567");
  await assert.rejects(() => d.optInDiscovery("u1"), /verified uid/);
  await assert.rejects(() => d.verify("08031234567", "000000"), /wrong code/);
  const ok = await d.verify("08031234567", "123456");
  assert.equal(ok.verified, true);
});

test("duplicate number refused; too many attempts cancel", async () => {
  const d = mkDir();
  await d.register("u1", "08031234567");
  await assert.rejects(() => d.register("u2", "08031234567"),
    /already registered/);
  const d2 = mkDir(async () => "999999");
  await d2.register("u1", "08031234567");
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => d2.verify("08031234567", "1"));
  }
  await assert.rejects(() => d2.verify("08031234567", "999999"),
    /too many attempts/);
});

test("discovery is opt-in, hashed, answer-only", async () => {
  const d = mkDir();
  await d.register("u1", "08031234567");
  await d.verify("08031234567", "123456");
  // not discoverable until opt-in
  let out = await d.discover(["08031234567"], "q1");
  assert.equal(out.found.length, 0);
  await d.optInDiscovery("u1");
  out = await d.discover(["08031234567", "08099999999"], "q1");
  assert.equal(out.found.length, 1);
  assert.equal(out.found[0].uid, "u1");
  assert.equal(out.scanned, 2);
  // opt-out really deletes
  await d.optOut("u1");
  out = await d.discover(["08031234567"], "q1");
  assert.equal(out.found.length, 0);
});

test("rate limit stops enumeration and surfaces it", async () => {
  const d = new IdentityDirectory({
    salt: SALT, otpIssuer: async () => "1", discoveryRateLimit: 5 });
  await d.discover(["08031234567", "08031234568"], "attacker");
  await assert.rejects(
    () => d.discover(["a", "b", "c", "d"], "attacker"), /rate limit/);
  assert.equal(d.stats().rateLimitHits, 1);
});

test("stats never expose the directory", async () => {
  const d = mkDir();
  await d.register("u1", "08031234567");
  await d.verify("08031234567", "123456");
  await d.optInDiscovery("u1");
  const s = d.stats();
  assert.equal(s.registered, 1);
  assert.equal(s.discoverable, 1);
  assert.ok(!("users" in s) && !("phones" in s));
});

test("constructor refuses missing salt or issuer", () => {
  assert.throws(() => new IdentityDirectory({ salt: null, otpIssuer: async () => "1" }));
  assert.throws(() => new IdentityDirectory({ salt: SALT }));
});
