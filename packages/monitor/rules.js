// rules.js — composite sensor-correlation rules (HA features 6–10).
//
// The adapter produces single signals; these rules correlate them over
// sliding windows. Alert economy doctrine: nudge locally first, alert
// family second, escalate last. And the cardinal honesty rule of home
// monitoring: HUB SILENCE IS NOT PATIENT SILENCE — a dead hub must
// never read as an emergency (or worse, as "all quiet").
//
// Signals consumed (from ha_adapter): presence{active}, checkin,
// device-alert; plus appliance{on}, cabinet_open, heartbeat — the last
// three are adapter-visible state, translated the same way.

export const DEFAULTS = Object.freeze({
  night_start_h: 22, night_end_h: 5,      // wandering window
  wander_seq_ms: 10 * 60 * 1000,          // motion -> door within 10 min
  stove_on_ms: 45 * 60 * 1000,            // stove on > 45 min
  fall_quiet_ms: 15 * 60 * 1000,          // no motion + no button 15 min
  hub_offline_ms: 10 * 60 * 1000,         // no heartbeat 10 min
  cabinet_grace_ms: 30 * 60 * 1000,       // cabinet opened, dose still unrecorded
});

const hour = (ts) => new Date(ts).getHours();
const isNight = (ts, r) =>
  hour(ts) >= r.night_start_h || hour(ts) < r.night_end_h;

// evaluate(signals, meds, now, rules) -> alerts[]
//   signals: [{type, entity?, active?, at}] in time order
//   meds:    [{plan_id, drug, due_at, recorded_at?}]
export function evaluate(signals, meds, now, R = DEFAULTS) {
  const alerts = [];
  const mk = (kind, severity, detail) =>
    alerts.push({ type: "huc.alert", kind, severity, at: now, ...detail });
  const last = (pred) => {
    for (let i = signals.length - 1; i >= 0; i--)
      if (pred(signals[i])) return signals[i];
    return null;
  };

  // --- 9. hub-offline FIRST: it gates how we read everything else ---
  const beat = last((s) => s.type === "heartbeat");
  const hubDead = !beat || now - beat.at > R.hub_offline_ms;
  if (hubDead)
    mk("hub-offline", "warning", {
      detail: beat ? `hub silent ${Math.round((now - beat.at) / 60000)} min`
                   : "no heartbeat ever seen",
      hub_silence_is_not_patient_silence: true });
  // When the hub is dead, patient-absence rules MUST NOT fire — sensor
  // silence carries no information about the patient.
  if (hubDead) return alerts;

  // --- 6. night wandering: night motion followed by door contact ---
  const nightMotion = last((s) => s.type === "presence" && s.active && isNight(s.at, R));
  if (nightMotion) {
    const door = last((s) => s.type === "presence" && /door|contact/.test(s.entity || "")
                          && s.active && s.at >= nightMotion.at
                          && s.at - nightMotion.at <= R.wander_seq_ms);
    if (door && isNight(door.at, R))
      mk("night-wandering", "emergency",
         { detail: "motion then door opened at night", motion_at: nightMotion.at, door_at: door.at });
  }

  // --- 7. stove watch: appliance on too long, no kitchen motion ---
  const stoveOn = last((s) => s.type === "appliance" && /stove|cooker/.test(s.entity || "") && s.active);
  if (stoveOn && now - stoveOn.at > R.stove_on_ms) {
    const kitchenMotion = last((s) => s.type === "presence" && /kitchen/.test(s.entity || "")
                                   && s.active && s.at >= stoveOn.at);
    if (!kitchenMotion)
      mk("stove-unattended", "emergency",
         { detail: `cooker on ${Math.round((now - stoveOn.at) / 60000)} min, no kitchen motion` });
  }

  // --- 8. fall signature: abrupt stop, then nothing, no button ---
  const anyMotion = last((s) => s.type === "presence" && s.active);
  const anyCheckin = last((s) => s.type === "checkin");
  if (anyMotion && now - anyMotion.at > R.fall_quiet_ms
      && (!anyCheckin || anyCheckin.at < anyMotion.at))
    mk("possible-fall", "family",
       { detail: `no motion for ${Math.round((now - anyMotion.at) / 60000)} min and no check-in`,
         precision: "low — ladder to family first, never straight to emergency" });

  // --- 10. med cabinet cross-check: opened near dose, dose unrecorded ---
  const cabinet = last((s) => s.type === "cabinet_open");
  if (cabinet) {
    for (const m of meds) {
      if (m.recorded_at) continue;
      const nearDose = Math.abs(cabinet.at - m.due_at) <= 3600 * 1000;
      if (nearDose && now - cabinet.at > R.cabinet_grace_ms)
        mk("dose-unrecorded-after-cabinet", "reminder",
           { plan_id: m.plan_id, drug: m.drug,
             detail: "cabinet opened near dose time but dose never recorded — remind in-home first" });
    }
  }
  return alerts;
}
