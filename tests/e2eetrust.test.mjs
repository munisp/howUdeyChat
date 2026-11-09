// e2eetrust.test.mjs — device identity, SAS ceremony, trust list,
// care-circle social recovery.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DeviceIdentity, SasCeremony, TrustList, CareCircleRecovery,
         E2EETRUST_VERSION } from "../packages/e2eetrust/e2eetrust.js";

test("version stamp", () => assert.equal(E2EETRUST_VERSION, "e2eetrust@1.0.0"));

test("device identity: fingerprint is the name, signatures verify", async () => {
  const a = await DeviceIdentity.generate();
  const b = await DeviceIdentity.generate();
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  const sig = await a.sign("room-key-share");
  const rawA = new Uint8Array(await crypto.subtle.exportKey("raw", a.pair.publicKey));
  assert.equal(await DeviceIdentity.verify(rawA, sig, "room-key-share"), true);
  assert.equal(await DeviceIdentity.verify(rawA, sig, "forged"), false);
});

test("SAS: both sides compute the same rendering; a swapped key changes it", async () => {
  const a = await DeviceIdentity.generate();
  const b = await DeviceIdentity.generate();
  const c = await DeviceIdentity.generate();   // the MITM
  const sideA = new SasCeremony(a.fingerprint, b.fingerprint, "nonce-1");
  const sideB = new SasCeremony(b.fingerprint, a.fingerprint, "nonce-1");
  const [ra, rb] = [await sideA.render(), await sideB.render()];
  assert.deepEqual(ra, rb);                    // order-independent
  assert.match(ra.decimal, /^\d{6}$/);
  const mitm = new SasCeremony(a.fingerprint, c.fingerprint, "nonce-1");
  assert.notDeepEqual(await mitm.render(), ra); // key swap is visible
});

test("trust list: keys only to verified devices; the ceremony is a human act", async () => {
  const tl = new TrustList("user-ada");
  const phone = await DeviceIdentity.generate();
  tl.addDevice(phone.fingerprint, "ada's tecno");
  assert.equal(tl.mayHoldKeys(phone.fingerprint), false);  // unverified
  assert.throws(() => tl.confirmSas(phone.fingerprint, { byUser: false }),
    /human act/);
  tl.confirmSas(phone.fingerprint, { byUser: true });
  assert.equal(tl.mayHoldKeys(phone.fingerprint), true);
  assert.throws(() => tl.confirmSas(phone.fingerprint), /theatre/);
  assert.throws(() => tl.confirmSas("ghost-fp"), /unknown is not verified/);
});

test("revocation: stated reasons only; revoked never holds keys", async () => {
  const tl = new TrustList("user-ada");
  const phone = await DeviceIdentity.generate();
  tl.addDevice(phone.fingerprint);
  tl.confirmSas(phone.fingerprint);
  tl.revoke(phone.fingerprint, "theft");
  assert.equal(tl.mayHoldKeys(phone.fingerprint), false);
  assert.throws(() => tl.revoke(phone.fingerprint, "vibes"), /stated reasons/);
  assert.equal(tl.audit.filter(a => a.action === "device-revoked").length, 1);
});

test("care-circle recovery: quorum + countersign + old device revoked", async () => {
  const tl = new TrustList("user-ada");
  const old = await DeviceIdentity.generate();
  const fresh = await DeviceIdentity.generate();
  tl.addDevice(old.fingerprint, "old phone");
  tl.confirmSas(old.fingerprint);

  const rec = new CareCircleRecovery(tl, {
    vouchers: ["mama", "uncle", "pastor", "nurse-ngozi"],
    officerPool: ["officer-1"] });

  assert.throws(() => rec.open(fresh.fingerprint, { lostDevice: "not-hers" }),
    /one of yours/);
  rec.open(fresh.fingerprint, { lostDevice: old.fingerprint });

  // unregistered voucher refuses
  assert.throws(() => rec.vouch("stranger"), /pre-registered/);
  rec.vouch("mama"); rec.vouch("uncle");
  // quorum before countersign — order matters
  assert.throws(() => rec.countersign("officer-1"), /quorum is 3/);
  rec.vouch("pastor");
  // an officer who also vouched could not countersign (separation) —
  // officer-1 never vouched, fine.
  const out = rec.countersign("officer-1");
  assert.equal(out.verified, fresh.fingerprint);
  assert.equal(out.revoked, old.fingerprint);
  assert.equal(tl.mayHoldKeys(fresh.fingerprint), true);
  assert.equal(tl.mayHoldKeys(old.fingerprint), false);
  assert.throws(() => rec.vouch("mama"), /no open recovery/);
});

test("recovery separation: a voucher who is an officer cannot countersign", async () => {
  const tl = new TrustList("user-b");
  const old = await DeviceIdentity.generate();
  tl.addDevice(old.fingerprint);
  tl.confirmSas(old.fingerprint);
  const rec = new CareCircleRecovery(tl, {
    vouchers: ["a", "b", "c"], officerPool: ["a"] });
  rec.open("new-fp", { lostDevice: old.fingerprint });
  rec.vouch("a"); rec.vouch("b"); rec.vouch("c");
  assert.throws(() => rec.countersign("a"), /never countersigns/);
});

test("recovery needs nominated vouchers — minimum quorum", () => {
  const tl = new TrustList("user-c");
  assert.throws(() => new CareCircleRecovery(tl, { vouchers: ["a", "b"],
    officerPool: ["o"] }), /at least 3/);
  assert.throws(() => new CareCircleRecovery(tl, { vouchers: ["a", "b", "c"],
    officerPool: [] }), /officer pool/);
});
