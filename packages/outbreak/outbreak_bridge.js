/* outbreak_bridge.js — connect the contact-tracing graph to the chat
 * care circles (seam: append-only NDJSON, the shape both sides test).
 *
 * Direction 1 — INBOUND worklists: the graph exports one
 *   {"kind":"trace-worklist","tracer":...,"overdue":[...],"due":[...]}
 *   line per tracer per day. This module renders the tracer's day and
 *   ARMS a monitor ladder for every overdue contact — a contact who has
 *   gone quiet is escalated, not noted.
 *
 * Direction 2 — OUTBOUND check-ins: kiosk ok-taps and monitor answers
 *   become {"kind":"trace-checkin",...} lines the graph ingests.
 *
 * Doctrine carried across the seam: hub silence is not patient silence
 * (the monitor rules engine decides what absence means; this bridge
 * never infers), and every outbound line is well-formed or not emitted.
 */

export function renderTracerDay(worklistLine) {
  const wl = JSON.parse(worklistLine);
  if (wl.kind !== "trace-worklist") throw new Error("not a worklist line");
  return {
    tracer: wl.tracer,
    day: wl.day,
    overdue: wl.overdue || [],
    due: wl.due || [],
    done: wl.done || [],
    // the ladder arming list: overdue contacts get escalation arms
    armLaddersFor: wl.overdue || [],
  };
}

/* Map a kiosk/monitor event to a trace-checkin line, or null when the
 * event is not check-in-shaped. symptomatic is carried only when the
 * event explicitly says so — absence of a symptom flag is NOT a healthy
 * declaration, but the graph treats missing as false, so we require the
 * field to be present to emit at all. */
export function toCheckinLine(ev) {
  if (!ev || ev.patient_id == null || ev.day == null) return null;
  if (!("symptomatic" in ev)) return null; // refuse to guess
  return JSON.stringify({
    kind: "trace-checkin",
    contact: ev.patient_id,
    day: ev.day,
    symptomatic: Boolean(ev.symptomatic),
  });
}

/* Batch conversion with honest rejection: malformed events are counted
 * and listed, never silently dropped — same doctrine as the graph side. */
export function batchCheckinLines(events) {
  const lines = [];
  const rejected = [];
  events.forEach((ev, i) => {
    const line = toCheckinLine(ev);
    if (line) lines.push(line);
    else rejected.push({ index: i, reason: "not check-in-shaped" });
  });
  return { lines, rejected };
}
