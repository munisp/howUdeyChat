// actions.js — actionable health artifacts (innovation 1).
//
// An appointment card in chat is not a picture of a decision — it IS the
// decision surface. One tap on "Confirm" or "Reschedule" emits a signed,
// idempotent action envelope that the OpenHealth OS channel gateway
// (ADR-0038) consumes. No app-switching, no phone call, no queue.
//
// Guarantees: every action is HMAC-signed by the patient device (tamper =
// reject), carries a unique id (replays are no-ops, never double-book),
// and the kind set is closed — unknown actions are rejected, never
// silently ignored.

import { hmacSign, hmacVerify } from "../sign/sign.js";

export const ACTION_KINDS = Object.freeze({
  "appointment.confirm": { ref: "appointment" },
  "appointment.reschedule": { ref: "appointment" },
  "result.ack": { ref: "result" },
  "refill.request": { ref: "prescription" },
});

let seq = 0;

// build an action envelope; keyBytes = this device's action-signing key.
export async function buildAction({ kind, refId, choice = null, actor }, keyBytes, now = Date.now()) {
  if (!ACTION_KINDS[kind]) throw new Error(`unknown action kind: ${kind}`);
  const action = { kind, ref_id: refId, choice, actor, ts: now };
  const id = `act-${now.toString(36)}-${(seq++).toString(36)}`;
  const sig = await hmacSign({ id, ...action }, keyBytes);
  return { type: "huc.action", id, action, sig };
}

// gateway-side intake: verify signature, reject unknown kinds, dedupe by id.
// seen: Map<id, true> shared across the gateway's intake. Fail-closed.
export async function intakeAction(env, keyBytes, seen = new Map()) {
  if (!env || env.type !== "huc.action" || !env.action) return { applied: false, reason: "malformed" };
  if (!ACTION_KINDS[env.action.kind]) return { applied: false, reason: "unknown-kind" };
  const ok = await hmacVerify({ id: env.id, ...env.action }, env.sig, keyBytes);
  if (!ok) return { applied: false, reason: "bad-signature" };
  if (seen.has(env.id)) return { applied: false, reason: "duplicate" };
  seen.set(env.id, true);
  return { applied: true, id: env.id, action: env.action };
}
