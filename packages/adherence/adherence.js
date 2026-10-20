// adherence.js — medication adherence loops (innovation 4).
//
// Refill and dose reminders arrive in chat with two buttons: Taken /
// Skipped. Every tap is an adherence event. The loop closes into
// OpenHealth OS: events roll up in the exact lakefeed contract shape
// (adherence_snapshot) so chronic registries (HIV, hypertension,
// diabetes) see real-world adherence without any extra data entry.
//
// Honest windows: a dose confirmed after LATE_WINDOW_MS counts as "late",
// not "taken on time" — registries deserve the truth.

export const LATE_WINDOW_MS = 4 * 3600 * 1000; // 4 hours

export class Adherence {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.plans = new Map();   // planId -> {patient, doses:[{id, dueAt, label}]}
    this.events = new Map();  // doseId -> {status, at}
  }
  schedule(planId, patient, doses) {
    this.plans.set(planId, { patient, doses });
    return doses.length;
  }
  due(planId, at = this.now()) {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`unknown plan: ${planId}`);
    return plan.doses.filter((d) => d.dueAt <= at && !this.events.has(d.id));
  }
  record(doseId, status, at = this.now()) {
    if (status !== "taken" && status !== "skipped") throw new Error(`bad status: ${status}`);
    if (this.events.has(doseId)) return { recorded: false, reason: "duplicate" };
    const plan = [...this.plans.values()].find((p) => p.doses.some((d) => d.id === doseId));
    if (!plan) throw new Error(`unknown dose: ${doseId}`);
    const dose = plan.doses.find((d) => d.id === doseId);
    const final = status === "taken" && at > dose.dueAt + LATE_WINDOW_MS ? "late" : status;
    this.events.set(doseId, { status: final, at });
    return { recorded: true, status: final };
  }
  // score over recorded doses: taken-on-time / all recorded. 0 when empty.
  score(planId) {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`unknown plan: ${planId}`);
    const rec = plan.doses.map((d) => this.events.get(d.id)).filter(Boolean);
    if (!rec.length) return 0;
    return rec.filter((e) => e.status === "taken").length / rec.length;
  }
  // lakefeed contract event — same shape OpenHealth OS chronicreg/lakefeed
  // consumes (registry_enrolment / adherence_snapshot family).
  toRegistryEvent(planId, facility, at = this.now()) {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`unknown plan: ${planId}`);
    return {
      event_type: "adherence_snapshot",
      occurred_at: new Date(at).toISOString(),
      facility_id: facility,
      patient_ref: plan.patient, // pseudonymous ref, never a raw identifier
      payload: { plan_id: planId, score: this.score(planId),
                 recorded: this.events.size, scheduled: plan.doses.length },
    };
  }
}
