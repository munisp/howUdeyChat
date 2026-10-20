// bulletin.js — offline health bulletins (innovation 9).
//
// Clinic hours changed. A cholera alert for the LGA. Antimalarials back
// in stock. These are signed bulletins that sync opportunistically and
// render from local cache with ZERO network — readable in airplane mode,
// like the zero-tile maps. Unsigned or expired bulletins never display:
// a forged "free surgery Sunday" notice is a known fraud pattern.

import { hmacSign, hmacVerify } from "../sign/sign.js";

export const BULLETIN_KINDS = Object.freeze(["hours", "outbreak", "stock", "general"]);

export async function issueBulletin({ id, facility, kind, body, validDays = 14 }, keyBytes, now = Date.now()) {
  if (!BULLETIN_KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  const core = { id, facility, kind, body, iat: now, exp: now + validDays * 86400 * 1000 };
  return { ...core, sig: await hmacSign(core, keyBytes) };
}

export class BulletinBoard {
  constructor(keyBytes) { this.key = keyBytes; this.items = new Map(); }
  // fail-closed intake: tampered or unknown-kind bulletins are rejected;
  // expired ones are dropped, not displayed.
  async add(b, now = Date.now()) {
    if (!BULLETIN_KINDS.includes(b.kind)) return { stored: false, reason: "unknown-kind" };
    if (b.exp <= now) return { stored: false, reason: "expired" };
    const { sig, ...core } = b;
    const ok = await hmacVerify(core, sig, this.key);
    if (!ok) return { stored: false, reason: "tampered" };
    this.items.set(b.id, b);
    return { stored: true };
  }
  // what's readable right now — newest first. Works fully offline.
  list(now = Date.now(), { kind = null, facility = null } = {}) {
    return [...this.items.values()]
      .filter((b) => b.exp > now)
      .filter((b) => !kind || b.kind === kind)
      .filter((b) => !facility || b.facility === facility)
      .sort((a, b2) => b2.iat - a.iat);
  }
}
