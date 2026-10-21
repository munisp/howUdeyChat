// kiosk.js — kiosk-mode patient view (care-circle evolution, item 2).
//
// The cared-for person is often elderly, low-literacy, and on a basic
// phone shared with the household. Kiosk mode is the anti-app: one
// screen, three jobs — WHAT DO I TAKE, WHERE DO I GO, I'M OKAY. No
// menus, no history, no settings. Render-agnostic: this module produces
// the view model; the chat surface or an always-on device renders it.
//
// Honesty rules: a med that was never recorded shows as MISSED, not
// hidden; an empty schedule says so rather than inventing calm.

export const OK_TAP = "im_okay";

// view(meds, appointments, checkins, now) -> kiosk view model.
//   meds:         [{plan_id, drug, due_at, recorded_at?}]
//   appointments: [{id, facility, at}]
//   checkins:     [{at}] (recent "I'm okay" taps, newest last)
export function view({ meds = [], appointments = [], checkins = [] }, now) {
  const dueMeds = meds
    .filter((m) => m.due_at <= now + 24 * 3600 * 1000) // today only
    .map((m) => ({
      plan_id: m.plan_id,
      drug: m.drug,
      status: m.recorded_at ? "taken" : (m.due_at <= now ? "missed" : "due"),
      due_at: m.due_at,
    }))
    .sort((a, b) => a.due_at - b.due_at);
  const nextAppt = appointments
    .filter((a) => a.at >= now)
    .sort((a, b) => a.at - b.at)[0] || null;
  const lastOk = checkins.length ? checkins[checkins.length - 1].at : null;
  return {
    due_meds: dueMeds,
    missed_count: dueMeds.filter((m) => m.status === "missed").length,
    next_appointment: nextAppt
      ? { id: nextAppt.id, facility: nextAppt.facility, at: nextAppt.at }
      : null,
    okay: {
      action: OK_TAP,
      last_ok_at: lastOk, // null = never checked in — shown honestly
    },
    empty: dueMeds.length === 0 && !nextAppt,
  };
}

// One-tap check-in. Returns the event to store; caller persists and —
// critically — the passive monitor consumes these to NOT alarm.
export function checkIn(patientId, now = Date.now()) {
  return { type: "huc.kiosk-ok", patient: patientId, at: now };
}
