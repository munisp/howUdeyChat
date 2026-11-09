/* bg-sync.js — background sync coordination: the outbox drains even when
 * the app isn't open — where the platform allows it, stated where not.
 *
 * Three rungs of the ladder, each stated honestly:
 *
 *  1. SW Background Sync ("periodic" + one-shot): Chrome/Android only;
 *     iOS Safari declines — stated, not faked.
 *  2. Foreground long-poll: always available; the baseline.
 *  3. Native shell workers (WorkManager / BGTaskScheduler): the Capacitor
 *     shell binds this; the binding is deployment-side (see
 *     .github/workflows/mobile-build.yml), the CONTRACT is here:
 *     declared battery budget, declared interval, stated wakeups.
 *
 * Doctrine:
 * - CAPABILITY IS DETECTED, NOT ASSUMED: support() probes; unsupported
 *   rungs report { supported: false } — never pretend-registered.
 * - BATTERY IS A BUDGET: the coordinator carries a declared daily wake
 *   budget; exceeding it defers to foreground-only with a stated note.
 * - THE OUTBOX IS THE TRUTH: background sync only triggers drainOutbox;
 *   it never invents sends of its own.
 */

export const BGSYNC_VERSION = "bgsync@1.0.0";

export const ONE_SHOT_TAG = "huc-outbox";
export const PERIODIC_TAG = "huc-sync-loop";
export const MIN_PERIODIC_INTERVAL_MS = 15 * 60 * 1000;   // platform floor

export function support(env = {}) {
  /* env: { serviceWorker?, syncManager?, periodicSync? } — injectable
   * so tests decide what the platform offers. */
  const sw = Boolean(env.serviceWorker);
  return {
    serviceWorker: sw,
    oneShot: sw && Boolean(env.syncManager),
    periodic: sw && Boolean(env.periodicSync),
    foregroundPoll: true,    // always the baseline
  };
}

export class BgSyncCoordinator {
  /* registration: a ServiceWorkerRegistration-like (injectable);
   * drain: async () => outbox drain result;
   * budget: declared wakes per day; now: injectable clock. */
  constructor({ registration = null, drain, wakesPerDay = 24,
                now = () => Date.now() } = {}) {
    if (typeof drain !== "function") {
      throw new Error("bg-sync coordinates a drain — without one it is nothing");
    }
    this.registration = registration;
    this.drain = drain;
    this.wakesPerDay = wakesPerDay;
    this.now = now;
    this.dayStamp = new Date(this.now()).toISOString().slice(0, 10);
    this.wakesToday = 0;
    this.log = [];
  }

  _rollDay() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.dayStamp) { this.dayStamp = d; this.wakesToday = 0; }
  }

  /* Register background sync where supported; the report states what
   * actually happened. */
  async register(env = {}) {
    const sup = support(env);
    const report = { requested: true, oneShot: false, periodic: false,
                     fallback: "foreground-poll", notes: [] };
    if (!sup.serviceWorker || !this.registration) {
      report.notes.push("no service worker — foreground poll only, stated");
      return report;
    }
    if (sup.oneShot) {
      await this.registration.sync.register(ONE_SHOT_TAG);
      report.oneShot = true;
    } else {
      report.notes.push("one-shot background sync unsupported — stated");
    }
    if (sup.periodic) {
      const status = await (this.registration.periodicSync.register(
        PERIODIC_TAG, { minInterval: MIN_PERIODIC_INTERVAL_MS })
        .then(() => "registered").catch(() => "denied"));
      report.periodic = status === "registered";
      if (!report.periodic) {
        report.notes.push("periodic sync denied by platform/user — stated");
      }
    }
    return report;
  }

  /* One wake — from the SW event, the native worker, or the timer.
   * The budget governs: over budget, defer with a stated note. */
  async wake(reason = "unspecified") {
    this._rollDay();
    if (this.wakesToday >= this.wakesPerDay) {
      const note = `wake budget spent (${this.wakesPerDay}/day) — ` +
                   "deferred to foreground, stated";
      this.log.push({ at: this.now(), reason, outcome: "deferred", note });
      return { drained: false, note };
    }
    this.wakesToday += 1;
    const res = await this.drain();
    this.log.push({ at: this.now(), reason, outcome: "drained",
                    sent: res && res.sent });
    return { drained: true, wake: this.wakesToday, of: this.wakesPerDay };
  }

  status() {
    this._rollDay();
    return { wakesToday: this.wakesToday, wakesPerDay: this.wakesPerDay,
             budgetRemaining: this.wakesPerDay - this.wakesToday };
  }
}
