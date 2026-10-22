// handover.js — bereavement & handover protocol (care-circle feature 5).
//
// Every circle ends someday, and improvisation at that moment is how
// records leak and debts fester. The protocol, in order:
//   1. close — no new grants, no new ledger entries, reason recorded
//   2. final settlement — the ledger's last fairness report
//   3. revoke — every member grant dies; the circle key stops working
//      for access checks (fail-closed: a closed circle denies everyone)
//   4. receipt — a signed, content-minimal archive receipt: what was
//      settled, what was revoked, where the record went (archive or
//      shredder). The receipt carries NO clinical content.
//
// Reasons: "deceased" | "facility-care" | "family-closed".

import { hmacSign } from "../sign/sign.js";

export const CLOSE_REASONS = Object.freeze(["deceased", "facility-care", "family-closed"]);

export async function closeCircle({ circle, ledger, reason, actorId, archive = "shredder",
                                    now = Date.now() }) {
  if (!CLOSE_REASONS.includes(reason))
    throw new Error(`unknown close reason: ${reason}`);
  if (!circle.canInvite(actorId))
    return { ok: false, reason: "only-the-owner-closes" };

  // 1+2. final settlement BEFORE anything is revoked
  const settlement = ledger ? await ledger.report() : null;

  // 3. revoke every grant
  const revoked = [];
  for (const memberId of [...circle.grants.keys()]) {
    if (circle.revoke(memberId)) revoked.push(memberId);
  }

  // 4. content-minimal signed receipt
  const body = {
    type: "huc.circle-closed",
    owner: circle.owner,
    reason,
    archive,
    revoked_members: revoked.sort(),
    final_total_spent: settlement ? settlement.total_spent : 0,
    final_settlements: settlement ? settlement.settlements : [],
    tampered_dropped: settlement ? settlement.tampered_dropped : 0,
    at: now,
  };
  const receipt = { ...body, sig: await hmacSign(body, circle.key) };
  return { ok: true, receipt };
}
