// gate.js — consent-gated messaging (innovation 2).
//
// In howUdeyChat, a clinician cannot simply "find" a patient and message
// them. The patient grants contact — scoped, expiring, revocable — and the
// relay/homeserver checks the grant token BEFORE delivery. No valid grant,
// no delivery. Fail-closed, always: an expired, tampered or out-of-scope
// token is denied, never "warned through".
//
// Scopes are narrow on purpose: "chat" (free messages), "results"
// (clinical artifacts), "campaign" (broadcast enrolment). A grant for
// chat does not permit results.

import { hmacSign, hmacVerify } from "../sign/sign.js";

export const SCOPES = Object.freeze(["chat", "results", "campaign"]);

// issue a grant token: patient @patient consents to contact from `contactId`.
export async function issueGrant({ patient, contactId, scope, ttlSeconds }, keyBytes, now = Date.now()) {
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope: ${scope}`);
  const body = { sub: patient, contact: contactId, scope, iat: now, exp: now + ttlSeconds * 1000 };
  const sig = await hmacSign(body, keyBytes);
  return { ...body, sig, revoked: false };
}

// delivery decision. Returns {allow, reason?}. Anything short of a valid,
// in-scope, unexpired, unrevoked grant denies.
export async function canDeliver(grant, { contactId, scope }, keyBytes, now = Date.now()) {
  if (!grant || grant.revoked) return { allow: false, reason: "revoked-or-missing" };
  if (grant.exp <= now) return { allow: false, reason: "expired" };
  if (grant.scope !== scope) return { allow: false, reason: "out-of-scope" };
  if (grant.contact !== contactId) return { allow: false, reason: "wrong-contact" };
  const { sig, revoked, ...body } = grant;
  const ok = await hmacVerify(body, sig, keyBytes);
  return ok ? { allow: true } : { allow: false, reason: "tampered" };
}
