// ledger.js — care-load fairness ledger (care-circle evolution, item 3).
//
// Families coordinate WORK, not just information: who visited Mama, who
// paid for the drugs, who escorted her to the PHC. Unrecorded labour
// breeds resentment; recorded labour can be balanced. Every entry is
// signed with the circle key (attribution cannot be forged later) and
// the fairness report proposes the minimal settlements that even the
// load — never a silent "everything is fine".
//
// Entry kinds: visit | expense | task. Expenses carry an amount (NGN);
// visits and tasks carry optional hours.

import { hmacSign, hmacVerify } from "../sign/sign.js";

export const LEDGER_KINDS = Object.freeze(["visit", "expense", "task"]);

export class Ledger {
  constructor(circle) {
    this.circle = circle; // entries only from owner or scoped members
    this.entries = [];
  }

  // Fail-closed: actor must currently hold circle access; kind must be
  // known; expenses must carry a positive amount.
  async record(actorId, { kind, amount = 0, hours = 0, note = "" }, now = Date.now()) {
    const access = await this.circle.hasAccess(actorId, now);
    if (!access.allow) throw new Error(`ledger denied: ${access.reason}`);
    if (!LEDGER_KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
    if (kind === "expense" && !(amount > 0))
      throw new Error("expense requires a positive amount");
    const body = { owner: this.circle.owner, member: actorId, kind, amount, hours, note, at: now };
    const entry = { ...body, sig: await hmacSign(body, this.circle.key) };
    this.entries.push(entry);
    return entry;
  }

  // Tamper-evident read: any entry whose signature broke is EXCLUDED
  // from fairness math and surfaced — never silently averaged in.
  async verified() {
    const out = { entries: [], dropped: [] };
    for (const e of this.entries) {
      const { sig, ...body } = e;
      (await hmacVerify(body, sig, this.circle.key)
        ? out.entries : out.dropped).push(e);
    }
    return out;
  }

  // Fairness: per-member load share + minimal settlement plan that
  // moves money from under-contributors to over-contributors. The owner
  // (the cared-for person) is the BENEFICIARY, not a contributor — they
  // are excluded from the expense split unless includeOwner is set.
  async report({ includeOwner = false } = {}) {
    const { entries, dropped } = await this.verified();
    const byMember = {};
    for (const e of entries) {
      const m = (byMember[e.member] ||= { visits: 0, tasks: 0, hours: 0, spent: 0 });
      if (e.kind === "visit") m.visits++;
      if (e.kind === "task") m.tasks++;
      m.hours += e.hours;
      m.spent += e.amount;
    }
    const members = Object.keys(byMember)
      .filter((m) => includeOwner || m !== this.circle.owner);
    const totalSpent = members.reduce((s, m) => s + byMember[m].spent, 0);
    const fairShare = members.length ? totalSpent / members.length : 0;
    // greedy minimal settlement: payers below fair share pay those above
    const debtors = members.map((m) => ({ m, bal: byMember[m].spent - fairShare }))
      .filter((d) => d.bal < -0.01).sort((a, b) => a.bal - b.bal);
    const creditors = members.map((m) => ({ m, bal: byMember[m].spent - fairShare }))
      .filter((c) => c.bal > 0.01).sort((a, b) => b.bal - a.bal);
    const settlements = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = Math.min(-debtors[i].bal, creditors[j].bal);
      settlements.push({ from: debtors[i].m, to: creditors[j].m, amount: Math.round(pay) });
      debtors[i].bal += pay; creditors[j].bal -= pay;
      if (Math.abs(debtors[i].bal) < 0.01) i++;
      if (Math.abs(creditors[j].bal) < 0.01) j++;
    }
    return { members: byMember, total_spent: totalSpent,
             fair_share: Math.round(fairShare), settlements,
             tampered_dropped: dropped.length };
  }
}
