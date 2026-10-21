// monitor.js — passive monitoring alerts (care-circle evolution, item 4).
//
// The signal is ABSENCE: Mama taps "I'm okay" every morning and records
// her meds; the day she doesn't, something may be wrong. This module
// turns missing signals into scoped alerts for the circle — the people
// with receive_results access hear it first.
//
// Data sources are the platform's OWN signals today (kiosk check-ins,
// adherence records); an adapter for ambient sensors (e.g. a Home
// Assistant class integration) is a T1+ deferred seam — the rule engine
// consumes "last seen" timestamps and does not care who produced them.
//
// Fail-closed: no signal history => NOT "all quiet", it is an explicit
// "no-data" alert — silence from a monitored elder is itself the signal.

export const RULES = Object.freeze({
  // no check-in by this hour (local) on a day => morning-alert
  morning_checkin_hour: 9,
  // a med this many hours overdue with no record => med-alert
  med_grace_hours: 4,
});

// assess({checkins, meds}, members, now) -> alerts[]
//   checkins: [{at}]   meds: [{plan_id, drug, due_at, recorded_at?}]
//   members:  [{id, scope}] — alerts are addressed only to
//             receive_results-scoped members (or the owner).
export function assess({ checkins = [], meds = [] }, members, now, rules = RULES) {
  const recipients = members
    .filter((m) => m.scope === "receive_results" || m.role === "owner")
    .map((m) => m.id);
  const alerts = [];
  const mk = (kind, detail) =>
    alerts.push({ type: "huc.alert", kind, to: recipients, at: now, ...detail });

  if (!recipients.length)
    return [{ type: "huc.alert", kind: "no-recipients", to: [], at: now }]; // loud, not silent

  // --- morning check-in rule ---
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const todayOk = checkins.some((c) => c.at >= dayStart.getTime());
  const pastHour = new Date(now).getHours() >= rules.morning_checkin_hour;
  if (!checkins.length)
    mk("no-data", { detail: "monitored patient has never checked in" });
  else if (pastHour && !todayOk)
    mk("morning-missed", { detail: "no check-in today after 09:00" });

  // --- medication silence rule ---
  for (const m of meds) {
    if (m.recorded_at) continue;
    const overdueMs = now - m.due_at;
    if (overdueMs > rules.med_grace_hours * 3600 * 1000)
      mk("med-overdue", { plan_id: m.plan_id, drug: m.drug,
                          overdue_hours: Math.floor(overdueMs / 3600000) });
  }
  return alerts;
}
