/* mediagov.js — the clinical media governor: compression tiers with a
 * diagnostic floor, data budgets that state their exhaustion.
 *
 * Field reality: a CHW on a 500MB monthly bundle photographs a wound,
 * a referral letter, an x-ray printout. Naive compression saves the
 * bundle and kills the diagnosis; no compression kills the bundle and
 * the app gets deleted. The governor resolves this as POLICY, not
 * habit:
 *
 *  - MEDIA CLASSES are registry entries with floors: a clinical photo
 *    has a stated minimum resolution/quality below which compression
 *    REFUSES (a blurry wound photo is a misdiagnosis machine).
 *  - TIERS are the user's data posture: full / saver / ultra. The tier
 *    picks the target; the floor can veto the tier.
 *  - BUDGETS are per-plan, per-day, stated: exhaustion is a message
 *    ("budget spent — queueing for Wi-Fi"), never a silent quality
 *    collapse.
 */

export const MEDIAGOV_VERSION = "mediagov@1.0.0";

export const MEDIA_CLASSES = Object.freeze({
  "clinical-photo": { floor: { minLongEdgePx: 1600, minQuality: 70 },
                      note: "wounds, rashes, x-ray prints — diagnostic quality or nothing" },
  "document":       { floor: { minLongEdgePx: 1200, minQuality: 65 },
                      note: "referral letters, lab printouts — text must stay legible" },
  "chat-photo":     { floor: { minLongEdgePx: 640, minQuality: 40 },
                      note: "social context — compresses freely" },
  "voice-note":     { floor: { minBitrateKbps: 16 },
                      note: "speech intelligibility floor" },
});

export const TIERS = Object.freeze({
  full:  { maxLongEdgePx: 4000, quality: 90, audioBitrateKbps: 64 },
  saver: { maxLongEdgePx: 1600, quality: 60, audioBitrateKbps: 24 },
  ultra: { maxLongEdgePx: 800,  quality: 40, audioBitrateKbps: 12 },
});

export function govern(cls, tier, { longEdgePx = null } = {}) {
  /* Returns the encoding plan, or refuses. The floor vetoes the tier. */
  const klass = MEDIA_CLASSES[cls];
  if (!klass) throw new Error(`unknown media class ${cls} — registry classes only`);
  const t = TIERS[tier];
  if (!t) throw new Error(`unknown tier ${tier} — full / saver / ultra`);
  const floor = klass.floor;
  if (cls === "voice-note") {
    const kbps = Math.max(t.audioBitrateKbps, floor.minBitrateKbps);
    return { class: cls, tier, audioBitrateKbps: kbps,
             floored: t.audioBitrateKbps < floor.minBitrateKbps };
  }
  const edge = Math.min(t.maxLongEdgePx, longEdgePx ?? t.maxLongEdgePx);
  if (edge < floor.minLongEdgePx) {
    throw new Error(
      `tier ${tier} would shrink ${cls} to ${edge}px (floor ` +
      `${floor.minLongEdgePx}px) — refusing: ${klass.note}`);
  }
  const quality = Math.max(t.quality, floor.minQuality);
  return { class: cls, tier, longEdgePx: edge, quality,
           floored: quality !== t.quality };
}

export class DataBudget {
  /* Per plan, per day, minor bookkeeping in KB. Exhaustion is stated. */
  constructor({ dailyKb, now = () => new Date().toISOString().slice(0, 10) } = {}) {
    if (!(dailyKb > 0)) throw new Error("a budget needs a size — stated in KB");
    this.dailyKb = dailyKb;
    this.today = now;               // injectable day
    this.days = new Map();          // day -> spentKb
    this.queued = [];               // deferred sends, stated
  }

  _spent() { return this.days.get(this.today()) || 0; }

  _spend(kb) {
    this.days.set(this.today(), this._spent() + kb);
  }

  /* May this media go over the mobile data right now? */
  admit(kind, kb, { onWifi = false } = {}) {
    if (!(kb >= 0)) throw new Error("size must be known — unknown size is not admitted");
    if (onWifi) return { admitted: true, via: "wifi", note: "Wi-Fi: budget untouched" };
    const remaining = this.dailyKb - this._spend();
    if (kb <= remaining) {
      this._spend(kb);
      return { admitted: true, via: "mobile", remainingKb: this.dailyKb - this._spend() };
    }
    this.queued.push({ kind, kb, day: this.today() });
    return { admitted: false, via: "queued-for-wifi",
             note: `budget spent (${this._spend()}/${this.dailyKb} KB) — ` +
                   "queued for Wi-Fi, stated, never silently shrunk" };
  }

  status() {
    return { day: this.today(), spentKb: this._spent(),
             dailyKb: this.dailyKb, queued: this.queued.length };
  }
}
