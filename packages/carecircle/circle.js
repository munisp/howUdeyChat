// circle.js — care circles (innovation 6).
//
// A grandmother's daughter should be able to sit in her mother's chat
// with the clinic — but only because the patient said so, only within
// the scope the patient set, and only until the grant expires. Mirrors
// the OpenHealth consent-service proxy doctrine: ONE level of delegation
// (a circle member can never invite someone else), narrow scopes
// (read / reply / receive_results), fail-closed checks.

import { hmacSign, hmacVerify } from "../sign/sign.js";

export const CIRCLE_SCOPES = Object.freeze(["read", "reply", "receive_results"]);

export class CareCircle {
  constructor(ownerId, keyBytes) {
    this.owner = ownerId;
    this.key = keyBytes;
    this.grants = new Map(); // memberId -> grant
  }
  async invite(memberId, scope, ttlSeconds, now = Date.now()) {
    if (memberId === this.owner) throw new Error("owner is implicitly a member");
    if (!CIRCLE_SCOPES.includes(scope)) throw new Error(`unknown scope: ${scope}`);
    const body = { owner: this.owner, member: memberId, scope, iat: now, exp: now + ttlSeconds * 1000 };
    const grant = { ...body, sig: await hmacSign(body, this.key), revoked: false };
    this.grants.set(memberId, grant);
    return grant;
  }
  // one-level delegation: only the owner can invite. A member trying to
  // re-invite is denied — delegation chains leak records.
  canInvite(actorId) { return actorId === this.owner; }
  revoke(memberId) {
    const g = this.grants.get(memberId);
    if (g) g.revoked = true;
    return !!g;
  }
  // scope-agnostic membership check: is this actor a current, untampered
  // member at all? (the care-load ledger needs contribution rights, not
  // a particular read/reply scope)
  async hasAccess(memberId, now = Date.now()) {
    if (memberId === this.owner) return { allow: true };
    const g = this.grants.get(memberId);
    if (!g || g.revoked) return { allow: false, reason: "revoked-or-missing" };
    if (g.exp <= now) return { allow: false, reason: "expired" };
    const { sig, revoked, ...body } = g;
    const ok = await hmacVerify(body, sig, this.key);
    return ok ? { allow: true } : { allow: false, reason: "tampered" };
  }
  async check(memberId, scope, now = Date.now()) {
    if (memberId === this.owner) return { allow: true }; // owner is always in
    const g = this.grants.get(memberId);
    if (!g || g.revoked) return { allow: false, reason: "revoked-or-missing" };
    if (g.exp <= now) return { allow: false, reason: "expired" };
    if (g.scope !== scope && !(g.scope === "reply" && scope === "read"))
      return { allow: false, reason: "out-of-scope" };
    const { sig, revoked, ...body } = g;
    const ok = await hmacVerify(body, sig, this.key);
    return ok ? { allow: true } : { allow: false, reason: "tampered" };
  }
}
