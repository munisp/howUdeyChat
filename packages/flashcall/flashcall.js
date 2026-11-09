/* flashcall.js — flash-call (missed-call) verification.
 *
 * A missed call costs the caller nothing — the one channel that works
 * on a zero-balance phone. The flow: the platform calls the user's
 * number and hangs up after one ring; the CLI (caller id) of that call
 * IS the proof, because only someone holding the phone sees it ring.
 * The user confirms by telling us the last digits of the number that
 * called them (or by calling back a stated number).
 *
 * Doctrine:
 * - THE NUMBER IS THE CODE: the expected CLI is drawn from a registered
 *   pool; the user enters the last N digits they saw. Guessing is
 *   bounded by attempt limits and expiry, same as OTP.
 * - ATTEMPTS BOUNDED, EXPIRY STATED: no immortal flash sessions.
 * - PROVIDERS PLUGGABLE, NO PRETEND DEFAULT: the dialer is injected
 *   (an aggregator with voice capability); without one, refuse loudly.
 * - ONE-SHOT: a verified session is consumed — it never verifies twice.
 */

export const FLASHCALL_VERSION = "flashcall@1.0.0";
export const FLASH_TTL_MS = 5 * 60 * 1000;   // 5 minutes, stated
export const MAX_ATTEMPTS = 3;

export class ClipoolRegistry {
  /* The pool of caller ids the deployment owns/leases. Data, not code. */
  constructor() { this.pool = []; }

  addRange(entries) {
    for (const e of entries) {
      if (!/^\+?\d{7,15}$/.test(e)) {
        throw new Error(`CLI ${e} is not a dialable number — pool entries are real`);
      }
      this.pool.push(e);
    }
    return this.pool.length;
  }

  draw(rng = Math.random) {
    if (!this.pool.length) throw new Error("empty CLI pool — no number to flash from");
    return this.pool[Math.floor(rng() * this.pool.length)];
  }
}

export class FlashCallVerifier {
  /* dialer: injected async (to, from) -> { status: "ringing"|"queued" }.
   * now: injectable clock. */
  constructor({ pool, dialer = null, now = () => Date.now(), rng = Math.random } = {}) {
    this.pool = pool;
    this.dialer = dialer;
    this.now = now;
    this.rng = rng;
    this.sessions = new Map();   // phone -> { cli, exp, attempts, verified }
  }

  async start(phone) {
    if (!this.dialer) {
      throw new Error("no dialer configured — refusing loudly rather " +
                      "than pretending to flash");
    }
    if (!/^\+?\d{7,15}$/.test(phone)) throw new Error("phone must be dialable");
    const cli = this.pool.draw(this.rng);
    const res = await this.dialer(phone, cli);
    if (!res || !["ringing", "queued"].includes(res.status)) {
      throw new Error(`dialer did not confirm the flash (got ${res && res.status}) — stated`);
    }
    this.sessions.set(phone, { cli, exp: this.now() + FLASH_TTL_MS,
                               attempts: 0, verified: false });
    return { status: "flashing", expiresInMs: FLASH_TTL_MS,
             instruction: "you will get a missed call — tell us the last 4 digits of the number that called" };
  }

  _session(phone) {
    const s = this.sessions.get(phone);
    if (!s) throw new Error("no flash session for this number — start one");
    if (this.now() > s.exp) {
      this.sessions.delete(phone);
      throw new Error("flash session expired — start over, stated");
    }
    if (s.verified) throw new Error("already verified — one-shot, consumed");
    return s;
  }

  verify(phone, lastDigits) {
    const s = this._session(phone);
    s.attempts += 1;
    if (s.attempts > MAX_ATTEMPTS) {
      this.sessions.delete(phone);
      throw new Error("too many guesses — session burned, start over");
    }
    const expected = s.cli.slice(-String(lastDigits).length);
    if (String(lastDigits) !== expected) {
      throw new Error(`digits do not match the flash (${s.attempts}/${MAX_ATTEMPTS})`);
    }
    s.verified = true;
    return { verified: true, note: "the missed call was seen by this phone" };
  }

  consume(phone) {
    /* Read the verdict exactly once. Consumption REQUIRES verification;
     * the session is then deleted — the proof does not linger. */
    const s = this.sessions.get(phone);
    if (!s) throw new Error("no flash session for this number — start one");
    if (this.now() > s.exp) {
      this.sessions.delete(phone);
      throw new Error("flash session expired — start over, stated");
    }
    if (!s.verified) throw new Error("not verified — nothing to consume");
    this.sessions.delete(phone);
    return { verified: true };
  }
}
