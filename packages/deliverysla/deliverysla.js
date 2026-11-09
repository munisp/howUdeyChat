/* deliverysla.js — delivery-SLA engine: stuck messages escalate, corridor
 * stats are a data product.
 *
 * The wagateway reports sent/delivered/read honestly — but nobody was
 * WATCHING. A result notification stuck at "sent" for six hours is a
 * clinical risk wearing a green badge. This engine watches: every
 * tracked message has a declared SLA per lane; a message that misses
 * its SLA raises an escalation decision (which the channel ladder can
 * act on), and corridor delivery stats accumulate for the extract
 * product.
 *
 * Doctrine:
 * - THE SLA IS DECLARED PER LANE: unregistered lane, no tracking —
 *   stated. Numbers without a declared target are decoration.
 * - STUCK IS A VERDICT, NOT A FEELING: a message is stuck when its
 *   status hasn't reached "delivered" within the lane's declared
 *   window. The escalation record names the lane, the wait, the SLA.
 * - STATS ARE FLOORED: corridor stats with fewer than K messages are
 *   suppressed — a 2-message corridor has no delivery rate, it has
 *   two anecdotes.
 * - THE CLOCK IS INJECTED: determinism in tests, honesty in prod.
 */

export const DELIVERYSLA_VERSION = "deliverysla@1.0.0";
export const K_FLOOR = 5;

const RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: -1 };

export class SlaRegistry {
  /* lane -> { deliverWithinMs, escalateTo? } — declared, never assumed */
  constructor() { this.slas = new Map(); }

  declare(lane, def) {
    if (!(def.deliverWithinMs > 0)) {
      throw new Error(`lane ${lane} needs a declared delivery window`);
    }
    this.slas.set(lane, { ...def });
    return this.slas.get(lane);
  }

  get(lane) {
    const s = this.slas.get(lane);
    if (!s) throw new Error(`no SLA declared for lane ${lane} — undeclared is untracked`);
    return s;
  }
}

export class DeliveryWatch {
  constructor({ registry, now = () => Date.now() } = {}) {
    this.registry = registry;
    this.now = now;
    this.tracked = new Map();     // ref -> { lane, corridor, sentAt, status }
    this.escalations = [];        // stated escalation decisions
    this.corridors = new Map();   // corridor -> { sent, delivered, withinSla, breached }
  }

  track(ref, lane, corridor) {
    const sla = this.registry.get(lane);   // undeclared lane refuses
    this.tracked.set(ref, { lane, corridor, sentAt: this.now(),
                            status: "sent", sla });
    const c = this.corridors.get(corridor)
      || { sent: 0, delivered: 0, withinSla: 0, breached: 0 };
    c.sent += 1;
    this.corridors.set(corridor, c);
  }

  /* Feed a status update (from wagateway statuses, pushlane acks...). */
  update(ref, status) {
    const t = this.tracked.get(ref);
    if (!t) throw new Error(`untracked ref ${ref} — unknown, not guessed`);
    if ((RANK[status] ?? -2) < (RANK[t.status] ?? -2)) {
      throw new Error(`status for ${ref} walked backwards — recorded as anomaly, not applied`);
    }
    t.status = status;
    if (status === "delivered" || status === "read") {
      const c = this.corridors.get(t.corridor);
      c.delivered += 1;
      if (this.now() - t.sentAt <= t.sla.deliverWithinMs) c.withinSla += 1;
    }
    return t;
  }

  /* Sweep: every tracked, undelivered message past its SLA escalates
   * exactly once — the decision names everything. */
  sweep() {
    const out = [];
    for (const [ref, t] of this.tracked) {
      if (["delivered", "read", "failed"].includes(t.status)) continue;
      if (t.escalated) continue;
      const waited = this.now() - t.sentAt;
      if (waited > t.sla.deliverWithinMs) {
        t.escalated = true;
        const esc = { ref, lane: t.lane, corridor: t.corridor,
                      waitedMs: waited, slaMs: t.sla.deliverWithinMs,
                      escalateTo: t.sla.escalateTo || null,
                      reason: `stuck at "${t.status}" for ${waited}ms ` +
                              `(SLA ${t.sla.deliverWithinMs}ms) — stated` };
        this.escalations.push(esc);
        out.push(esc);
        this.corridors.get(t.corridor).breached += 1;
      }
    }
    return out;
  }

  /* Corridor delivery stats — suppressed below the k-floor. */
  stats(corridor) {
    const c = this.corridors.get(corridor);
    if (!c) throw new Error(`no corridor ${corridor} — nothing tracked, stated`);
    if (c.sent < K_FLOOR) {
      return { corridor, suppressed: true,
               reason: `fewer than ${K_FLOOR} messages — a rate needs a denominator` };
    }
    return { corridor, suppressed: false, sent: c.sent, delivered: c.delivered,
             deliveryRate: c.delivered / c.sent,
             withinSlaRate: c.delivered ? c.withinSla / c.delivered : 0,
             breached: c.breached };
  }
}
