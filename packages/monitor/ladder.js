// ladder.js — alert escalation ladder (care-circle feature 2).
//
// A broadcast-to-everyone alert trains everyone to ignore it. A ladder
// alerts ONE person, waits for a signed acknowledgement, and climbs only
// when unheard. The final rung is the clinic — an unanswered ladder must
// end with a human professional, never fade into silence. Fail-closed:
// acks are HMAC-signed and bound to the rung; a stale or forged ack
// does not stop the climb.

import { hmacSign, hmacVerify } from "../sign/sign.js";

export class Ladder {
  // rungs: [{to: "adaeze", ack_window_ms: 1800e3}, ..., {to: "clinic"}]
  // The clinic rung needs no window — it is where the ladder ENDS.
  constructor(circleKey, rungs) {
    if (!rungs.length) throw new Error("ladder needs at least one rung");
    this.key = circleKey;
    this.rungs = rungs;
    this.state = null; // active alert state
  }

  // An alert enters the ladder.
  start(alert, now = Date.now()) {
    this.state = { alert, rung: 0, entered_at: now, acked: false, history: [] };
    return this.current(now);
  }

  current(now = Date.now()) {
    const s = this.state;
    if (!s || s.acked) return null;
    return { to: this.rungs[s.rung].to, rung: s.rung, alert: s.alert,
             deadline: s.entered_at + (this.rungs[s.rung].ack_window_ms ?? Infinity) };
  }

  // Signed acknowledgement. Only the current rung's holder can ack.
  async ack(memberId, now = Date.now()) {
    const s = this.state;
    if (!s || s.acked) return { ok: false, reason: "no-active-alert" };
    const rung = this.rungs[s.rung];
    if (rung.to !== memberId) return { ok: false, reason: "not-your-rung" };
    const body = { type: "huc.ladder-ack", alert: s.alert.kind || s.alert.type,
                   rung: s.rung, member: memberId, at: now };
    s.ack_sig = await hmacSign(body, this.key);
    s.acked = true;
    s.history.push({ rung: s.rung, acked_by: memberId, at: now });
    return { ok: true };
  }

  // Clock tick: past the ack window? Climb. Fail-closed — the climb
  // never skips the clinic rung, and a tampered ack_sig (state edited
  // out of band) is treated as UNACKNOWLEDGED.
  async advance(now = Date.now()) {
    const s = this.state;
    if (!s || s.acked) {
      if (s?.acked && s.ack_sig) {
        const body = { type: "huc.ladder-ack", alert: s.alert.kind || s.alert.type,
                       rung: s.history[s.history.length - 1]?.rung,
                       member: this.rungs[s.history[s.history.length - 1]?.rung]?.to,
                       at: s.history[s.history.length - 1]?.at };
        if (!(await hmacVerify(body, s.ack_sig, this.key)))
          return { escalated: true, reason: "ack-tampered", to: "clinic" };
      }
      return { escalated: false };
    }
    const rung = this.rungs[s.rung];
    const deadline = s.entered_at + (rung.ack_window_ms ?? Infinity);
    if (now < deadline) return { escalated: false, to: rung.to };
    s.history.push({ rung: s.rung, missed: true, at: deadline });
    if (s.rung + 1 >= this.rungs.length) {
      // past the final rung: the clinic IS the final rung by contract;
      // if somehow not, end loud rather than silent
      return { escalated: true, to: "clinic", reason: "ladder-exhausted" };
    }
    s.rung++;
    s.entered_at = now;
    return { escalated: true, to: this.rungs[s.rung].to, rung: s.rung };
  }
}
