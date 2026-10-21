// magiclink.test.mjs — magic-link circle invites (care-circle evolution).
import { test } from "node:test";
import assert from "node:assert/strict";

import { newKey } from "../packages/sign/sign.js";
import { CareCircle } from "../packages/carecircle/circle.js";
import { MagicLinks } from "../packages/carecircle/magiclink.js";

const key = await newKey();
const NOW = 1_700_000_000_000;

test("magic link: mint -> redeem creates a working scoped grant", async () => {
  const circle = new CareCircle("mama", key);
  const links = new MagicLinks(circle);
  const link = await links.mint("chinedu", "read", 86400, NOW);
  assert.match(link, /^HUC-INVITE\./);
  const r = await links.redeem(link, NOW + 1000);
  assert.equal(r.ok, true);
  assert.equal(r.member, "chinedu");
  // the grant is real: circle.check honours it
  assert.equal((await circle.check("chinedu", "read", NOW + 2000)).allow, true);
  // ...and it is scoped: receive_results was never granted
  assert.equal((await circle.check("chinedu", "receive_results", NOW + 2000)).allow, false);
});

test("magic link: one-time — replay is refused", async () => {
  const circle = new CareCircle("mama", key);
  const links = new MagicLinks(circle);
  const link = await links.mint("adaeze", "reply", 86400, NOW);
  assert.equal((await links.redeem(link, NOW)).ok, true);
  const again = await links.redeem(link, NOW + 1);
  assert.deepEqual(again, { ok: false, reason: "redeemed" });
});

test("magic link: expired, tampered, malformed, wrong-circle all fail closed", async () => {
  const circle = new CareCircle("mama", key);
  const other = new CareCircle("papa", await newKey());
  const links = new MagicLinks(circle);

  const expired = await links.mint("ngozi", "read", 10, NOW);
  assert.equal((await links.redeem(expired, NOW + 20_000)).reason, "expired");

  const good = await links.mint("ngozi", "read", 3600, NOW);
  // flip one character in the payload segment — signature must fail
  const segs = good.split(".");
  const flip = segs[1][0] === "A" ? "B" : "A";
  const tampered = [segs[0], flip + segs[1].slice(1), segs[2]].join(".");
  const tres = await links.redeem(tampered, NOW);
  assert.ok(["tampered", "malformed"].includes(tres.reason),
    `expected tampered/malformed, got ${JSON.stringify(tres)}`);

  assert.equal((await links.redeem("HUC-INVITE.garbage", NOW)).reason, "malformed");
  assert.equal((await links.redeem("not-a-link", NOW)).reason, "malformed");

  // a link minted by mama's circle cannot join papa's circle
  const foreign = await links.mint("ngozi", "read", 3600, NOW);
  const foreignLinks = new MagicLinks(other);
  assert.equal((await foreignLinks.redeem(foreign, NOW)).reason, "wrong-circle");
});

test("magic link: mint guards — owner cannot self-invite, unknown scope refused", async () => {
  const circle = new CareCircle("mama", key);
  const links = new MagicLinks(circle);
  await assert.rejects(() => links.mint("mama", "read", 60, NOW), /implicitly a member/);
  await assert.rejects(() => links.mint("son", "admin", 60, NOW), /unknown scope/);
});

test("magic link: delegation stays one level — links carry no invite power", async () => {
  const circle = new CareCircle("mama", key);
  const links = new MagicLinks(circle);
  const link = await links.mint("chinedu", "read", 3600, NOW);
  await links.redeem(link, NOW);
  // chinedu is now a member, but a member can never mint or invite
  assert.equal(circle.canInvite("chinedu"), false);
});
