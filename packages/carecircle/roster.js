// roster.js — visit roster with coverage-gap detection (care-circle 3).
//
// The ledger records visits after the fact; the roster plans them ahead.
// Rule: Mama should not be alone longer than `max_gap_days`. Members
// claim days; the coverage report flags uncovered windows BEFORE they
// become emergencies. Fail-closed: only current members claim; a claim
// for a day already claimed is refused, not silently shared.

const DAY = 86400 * 1000;

export class Roster {
  constructor(circle, { max_gap_days = 2 } = {}) {
    this.circle = circle;
    this.maxGap = max_gap_days;
    this.claims = new Map(); // dayKey (YYYY-MM-DD) -> memberId
  }

  static dayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }

  async claim(dayTs, memberId, now = Date.now()) {
    const access = await this.circle.hasAccess(memberId, now);
    if (!access.allow) return { ok: false, reason: access.reason };
    const k = Roster.dayKey(dayTs);
    if (this.claims.has(k)) return { ok: false, reason: "day-already-claimed" };
    this.claims.set(k, memberId);
    return { ok: true, day: k };
  }

  release(dayTs, memberId) {
    const k = Roster.dayKey(dayTs);
    if (this.claims.get(k) !== memberId) return false; // only your own claim
    this.claims.delete(k);
    return true;
  }

  // Coverage from `fromTs` for `days`: which days are claimed, by whom,
  // and — the point — which windows exceed max_gap_days unclaimed.
  coverage(fromTs, days) {
    const out = { days: [], gaps: [] };
    let run = 0, runStart = null;
    for (let i = 0; i < days; i++) {
      const ts = fromTs + i * DAY;
      const k = Roster.dayKey(ts);
      const who = this.claims.get(k) || null;
      out.days.push({ day: k, claimed_by: who });
      if (who) { run = 0; runStart = null; }
      else {
        if (run === 0) runStart = k;
        run++;
        if (run >= this.maxGap)
          out.gaps.push({ start: runStart, length_days: run });
      }
    }
    return out;
  }
}
