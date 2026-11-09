/* ladder.js — the channel ladder: stated escalation, costed per corridor.
 *
 * A message that must arrive — an outbreak alert, a result ready, a
 * coverage verdict — gets a plan, not a hope. The plan is a corridor
 * registry entry: an ordered list of lanes (push → whatsapp → sms →
 * ussd), each with a declared ack window and a declared cost. The
 * ladder walks the plan; every hop and every escalation reason is
 * recorded ON the message record, so "we WhatsApp'd them, it stuck at
 * sent, we fell back to SMS" is the record, not a postmortem.
 *
 * Doctrine:
 * - THE PLAN IS DATA: corridors and lane orders are registry entries,
 *   never code branches. Unknown corridor / unknown lane refuses.
 * - ESCALATION IS STATED: a hop escalates only for a recorded reason
 *   (send failure, no-ack within the lane's window). The message record
 *   carries the whole chain.
 * - COST IS VISIBLE: every hop posts to a per-corridor ledger in
 *   minor units; the statement is checksummed. Cheap lanes first is a
 *   corridor decision, not a habit.
 * - SILENCE IS NOT SUCCESS: a lane that neither acks nor errors inside
 *   its window is "unconfirmed" — the ladder escalates and says so.
 */

export const LADDER_VERSION = "ladder@1.0.0";

export const LANE_IDS = Object.freeze(["push", "whatsapp", "sms", "ussd"]);

export class CorridorRegistry {
  /* corridor -> { lanes: [{ id, ackWindowMs, costMinor }], currency } */
  constructor() { this.corridors = new Map(); }

  register(corridor, def) {
    if (!corridor) throw new Error("corridor name required");
    if (!Array.isArray(def.lanes) || !def.lanes.length) {
      throw new Error("a corridor with no lanes is not a plan");
    }
    if (!def.currency) throw new Error("corridor currency required — costs need a unit");
    for (const l of def.lanes) {
      if (!LANE_IDS.includes(l.id)) {
        throw new Error(`unknown lane ${l.id} — registry lanes only`);
      }
      if (!(l.ackWindowMs > 0)) {
        throw new Error(`lane ${l.id} needs a declared ack window`);
      }
      if (!(l.costMinor >= 0)) {
        throw new Error(`lane ${l.id} needs a declared cost (0 is a declaration)`);
      }
    }
    const ids = def.lanes.map(l => l.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error("duplicate lane in a plan — a loop is not a ladder");
    }
    this.corridors.set(corridor, {
      lanes: def.lanes.map(l => ({ ...l })), currency: def.currency });
    return this.corridors.get(corridor);
  }

  plan(corridor) {
    const c = this.corridors.get(corridor);
    if (!c) throw new Error(`unknown corridor ${corridor} — no plan, no send`);
    return c;
  }
}

export class ChannelLadder {
  /* lanes: { push?, whatsapp?, sms?, ussd? } — adapter objects with an
   * async send(contact, message) that resolves { status } where status
   * is "sent"|"delivered"|"queued" and may later update. The ladder
   * treats "delivered" as the only ack that stops the walk; everything
   * else waits out the ack window, then escalates with a stated reason.
   * clock: injectable for tests. */
  constructor({ corridors, lanes = {}, now = () => Date.now(),
                sleep = null } = {}) {
    this.corridors = corridors;
    this.lanes = lanes;
    this.now = now;
    this.sleep = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    this.records = [];
    this.ledger = new Map();   // corridor -> { currency, totalMinor, hops }
  }

  _post(corridor, laneId, costMinor) {
    const plan = this.corridors.plan(corridor);
    const cur = this.ledger.get(corridor)
      || { currency: plan.currency, totalMinor: 0, hops: 0 };
    cur.totalMinor += costMinor;
    cur.hops += 1;
    this.ledger.set(corridor, cur);
  }

  async send(corridor, contact, message) {
    const plan = this.corridors.plan(corridor);
    const record = { corridor, contact, messageRef: message.ref || null,
                     attempts: [], outcome: null, startedAt: this.now() };
    this.records.push(record);
    for (const laneDef of plan.lanes) {
      const adapter = this.lanes[laneDef.id];
      if (!adapter) {
        record.attempts.push({ lane: laneDef.id, outcome: "unavailable",
          reason: "lane not configured — skipped, stated" });
        continue;
      }
      this._post(corridor, laneDef.id, laneDef.costMinor);
      let res;
      try {
        res = await adapter.send(contact, message);
      } catch (e) {
        record.attempts.push({ lane: laneDef.id, outcome: "failed",
          reason: String(e.message || e) });
        continue;
      }
      if (res && res.status === "delivered") {
        record.attempts.push({ lane: laneDef.id, outcome: "delivered" });
        record.outcome = { state: "delivered", via: laneDef.id };
        return record;
      }
      /* sent/queued: wait the declared ack window for a delivery ack,
       * then escalate — unconfirmed is not delivered. */
      record.attempts.push({ lane: laneDef.id, outcome: res ? res.status : "sent" });
      const ack = await this._awaitAck(adapter, res, laneDef.ackWindowMs);
      if (ack_is_delivery(ack)) {
        record.attempts.push({ lane: laneDef.id, outcome: "delivered" });
        record.outcome = { state: "delivered", via: laneDef.id };
        return record;
      }
      record.attempts.push({ lane: laneDef.id, outcome: "unconfirmed",
        reason: `no delivery ack within ${laneDef.ackWindowMs}ms — escalating, stated` });
    }
    record.outcome = { state: "undelivered",
      via: null, note: "every lane in the plan was tried; stated, not retried forever" };
    return record;
  }

  async _awaitAck(adapter, res, windowMs) {
    if (typeof adapter.pollStatus !== "function") return null;
    const deadline = this.now() + windowMs;
    while (this.now() < deadline) {
      await this.sleep(Math.min(1000, deadline - this.now()));
      const st = await adapter.pollStatus(res);
      if (st && st.status) return st;
    }
    return null;
  }

  /* Per-corridor cost statement. The checksum is the contract. */
  async statement(corridor) {
    const cur = this.ledger.get(corridor);
    if (!cur) throw new Error(`no ledger for corridor ${corridor} — nothing spent, stated`);
    const body = { corridor, ...cur, generatedAt: this.now() };
    const data = new TextEncoder().encode(
      JSON.stringify(body, Object.keys(body).sort()));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return { ...body,
      sha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("") };
  }
}

function ack_is_delivery(ack) { return ack && ack.status === "delivered"; }
