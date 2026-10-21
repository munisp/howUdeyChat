// magiclink.js — magic-link circle invites (care-circle evolution).
//
// The insight (from market prior art, implemented here entirely from our
// own packages/sign machinery): the biggest barrier to a working care
// circle is not consent — it is ONBOARDING. Mama's son in Kano should
// not need to create a platform account before he can read her results.
// The owner issues a signed, scoped, expiring link; whoever holds it
// redeems it once, in chat, and the circle grant is born.
//
// Fail-closed doctrine, same as circle.js: expired, tampered, re-used,
// or wrong-scope links are rejected with a reason, never silently
// widened. One level of delegation still holds: a magic link can only
// be minted by the owner, and redeeming it grants membership — never
// invite power.

import { hmacSign, hmacVerify, newKey } from "../sign/sign.js";
import { CIRCLE_SCOPES } from "./circle.js";

const b64u = (s) =>
  Buffer.from(typeof s === "string" ? s : JSON.stringify(s))
    .toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();

export class MagicLinks {
  // circle: a CareCircle instance (its owner + key sign the links).
  constructor(circle) {
    this.circle = circle;
    this.redeemed = new Set(); // invite ids already consumed
  }

  // Owner mints a one-time link for a named invitee and a single scope.
  // memberId is bound INTO the link — a link minted for Chinedu cannot
  // create a grant for anyone else.
  async mint(memberId, scope, ttlSeconds, now = Date.now()) {
    if (memberId === this.circle.owner)
      throw new Error("owner is implicitly a member");
    if (!CIRCLE_SCOPES.includes(scope))
      throw new Error(`unknown scope: ${scope}`); // fail fast at mint
    const inviteId = b64u(Buffer.from(await newKey()).toString("hex"))
      .slice(0, 24);
    const body = {
      type: "huc.circle-invite",
      owner: this.circle.owner,
      member: memberId,
      scope,
      id: inviteId,
      iat: now,
      exp: now + ttlSeconds * 1000,
    };
    const sig = await hmacSign(body, this.circle.key);
    return `HUC-INVITE.${b64u(body)}.${sig}`;
  }

  // Holder redeems the link -> a real circle grant appears. One-time.
  async redeem(link, now = Date.now()) {
    const parts = typeof link === "string" ? link.split(".") : [];
    if (parts.length !== 3 || parts[0] !== "HUC-INVITE")
      return { ok: false, reason: "malformed" };
    let body;
    try {
      body = JSON.parse(unb64u(parts[1]));
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (body.type !== "huc.circle-invite" || !body.id || !body.member)
      return { ok: false, reason: "malformed" };
    if (body.owner !== this.circle.owner)
      return { ok: false, reason: "wrong-circle" };
    if (body.exp <= now) return { ok: false, reason: "expired" };
    if (this.redeemed.has(body.id)) return { ok: false, reason: "redeemed" };
    if (!(await hmacVerify(body, parts[2], this.circle.key)))
      return { ok: false, reason: "tampered" };
    // signature valid -> mint the real grant through the circle's own
    // fail-closed path (scope validation lives there, not here)
    const grant = await this.circle.invite(
      body.member, body.scope, Math.ceil((body.exp - now) / 1000), now);
    this.redeemed.add(body.id);
    return { ok: true, member: body.member, scope: body.scope, grant };
  }
}
