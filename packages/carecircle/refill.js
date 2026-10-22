// refill.js — medication refill relay (care-circle feature 1).
//
// Adherence dies at the refill gap, not the daily dose. When a plan
// runs low, the circle gets a task; one member claims it with a signed
// action; collection closes the loop. Fail-closed: only current circle
// members can claim, a claimed task cannot be re-claimed, and collection
// must come from the claimant — no silent completions.

import { hmacSign, hmacVerify } from "../sign/sign.js";

export class RefillRelay {
  constructor(circle) {
    this.circle = circle;
    this.tasks = new Map(); // planId -> task
  }

  // Plan running low opens a task. Idempotent: a second low signal for
  // the same open plan updates the estimate, never forks the task.
  open(planId, drug, { daysLeft, now = Date.now() } = {}) {
    const t = this.tasks.get(planId);
    if (t && t.state !== "collected") {
      t.days_left = daysLeft; // honest update
      return t;
    }
    const task = { plan_id: planId, drug, days_left: daysLeft,
                   state: "open", opened_at: now, claimed_by: null };
    this.tasks.set(planId, task);
    return task;
  }

  async claim(planId, memberId, now = Date.now()) {
    const access = await this.circle.hasAccess(memberId, now);
    if (!access.allow) return { ok: false, reason: access.reason };
    const t = this.tasks.get(planId);
    if (!t) return { ok: false, reason: "no-such-task" };
    if (t.state === "collected") return { ok: false, reason: "already-collected" };
    if (t.state === "claimed") return { ok: false, reason: "already-claimed" };
    const body = { type: "huc.refill-claim", plan_id: planId, member: memberId, at: now };
    t.state = "claimed";
    t.claimed_by = memberId;
    t.claim_body = body;
    t.claim_sig = await hmacSign(body, this.circle.key);
    return { ok: true, task: t };
  }

  async collect(planId, memberId, now = Date.now()) {
    const t = this.tasks.get(planId);
    if (!t) return { ok: false, reason: "no-such-task" };
    if (t.state !== "claimed") return { ok: false, reason: "not-claimed" };
    if (t.claimed_by !== memberId) return { ok: false, reason: "not-the-claimant" };
    // verify the claim before closing — a forged claim state cannot be
    // laundered into a collection
    if (!(await hmacVerify(t.claim_body, t.claim_sig, this.circle.key)))
      return { ok: false, reason: "claim-tampered" };
    t.state = "collected";
    t.collected_at = now;
    return { ok: true, task: t };
  }

  // What does the circle see right now? Open tasks oldest-first.
  pending(now = Date.now()) {
    return [...this.tasks.values()]
      .filter((t) => t.state !== "collected")
      .sort((a, b) => a.opened_at - b.opened_at);
  }
}
