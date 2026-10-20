// verify.js — verified staff identity & anti-fraud (innovation 5).
//
// Health scams thrive on WhatsApp because anyone can name an account "Dr
// Ade". In howUdeyChat every staff message carries a signed badge:
// licence number, council (MDCN/NMCN/PCN/...), expiry — HMAC-sealed by
// the provisioning service (ADR-0010) at onboarding. The patient client
// verifies offline; an unverified sender is visibly flagged, never
// silently trusted. Badges are also printable as HUC1 QR strings so a
// paper referral can be checked against the same key.

import { hmacSign, hmacVerify } from "../sign/sign.js";

const te = new TextEncoder(), td = new TextDecoder();
const b64 = {
  enc: (s) => btoa(unescape(encodeURIComponent(s))),
  dec: (s) => decodeURIComponent(escape(atob(s))),
};

export async function issueBadge({ staffId, name, council, licence, ttlDays = 90 }, keyBytes, now = Date.now()) {
  const body = { staff_id: staffId, name, council, licence, iat: now, exp: now + ttlDays * 86400 * 1000 };
  const sig = await hmacSign(body, keyBytes);
  return { ...body, sig };
}

export function badgeQR(badge) {
  return `HUC1.${b64.enc(JSON.stringify({ ...badge, sig: undefined, sigRef: true }))}.${badge.sig}`;
}

// fail-closed: bad encoding, bad signature, expired — all unverified.
export async function verifyBadge(input, keyBytes, now = Date.now()) {
  let badge = input;
  if (typeof input === "string") {
    const m = input.match(/^HUC1\.([A-Za-z0-9+/=]+)\.([0-9a-f]+)$/);
    if (!m) return { verified: false, reason: "malformed" };
    try { badge = { ...JSON.parse(b64.dec(m[1])), sig: m[2] }; }
    catch { return { verified: false, reason: "malformed" }; }
    delete badge.sigRef;
  }
  if (badge.exp <= now) return { verified: false, reason: "expired" };
  const { sig, ...body } = badge;
  const ok = await hmacVerify(body, sig, keyBytes);
  return ok ? { verified: true, badge: body } : { verified: false, reason: "tampered" };
}
