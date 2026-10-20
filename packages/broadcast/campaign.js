// campaign.js — targeted broadcast campaigns (innovation 7).
//
// "All children under 5 in Wuse district: measles catch-up Saturday." A
// ministry or facility can reach exactly a cohort — by facility, LGA, or
// programme tag — through the channel patients already read. Delivery is
// respectful by law of the platform: quiet hours are honoured (a campaign
// never buzzes a phone at 2am), enrolment requires a "campaign"-scope
// consent grant, and analytics are aggregate tallies — never per-patient
// read receipts sold upstream.

export const QUIET_HOURS = Object.freeze({ start: 21, end: 7 }); // 21:00–07:00 local

export class Campaign {
  constructor({ id, cohort = {}, body, kind = "general" }) {
    if (!id || !body) throw new Error("id and body required");
    this.id = id; this.cohort = cohort; this.body = body; this.kind = kind;
    this.tallies = { sent: 0, delivered: 0, read: 0, failed: 0 };
  }
  // does this member match the cohort? all specified keys must match.
  matches(member) {
    if (member.consent !== "campaign") return false; // no consent, no campaign
    for (const k of ["facility", "lga", "tag"]) {
      if (this.cohort[k] && member[k] !== this.cohort[k]) return false;
    }
    return true;
  }
  target(members) { return members.filter((m) => this.matches(m)); }
  // quiet hours: only "emergency" kind (e.g. outbreak alert) may override.
  sendWindowOk(at = new Date()) {
    if (this.kind === "emergency") return true;
    const h = at.getHours();
    return !(h >= QUIET_HOURS.start || h < QUIET_HOURS.end);
  }
  record(status) {
    if (!(status in this.tallies)) throw new Error(`bad status: ${status}`);
    this.tallies[status]++;
    return this.tallies;
  }
  report() {
    const { sent, delivered, read, failed } = this.tallies;
    return { id: this.id, kind: this.kind, sent, delivered, read, failed,
             delivery_rate: sent ? delivered / sent : 0 };
  }
}
