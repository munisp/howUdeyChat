/* otpchannel.js — pluggable OTP delivery channels (SMS / USSD / CHW tablet).
 *
 * identity.js needs a way to get a code to a phone. Deployments differ:
 * an SMS aggregator in one state, USSD push in another, a CHW reading
 * the code off a tablet where there is no signal at all. This module is
 * the honest channel layer: providers are pluggable, every send is
 * logged, failures fail loudly, and there is NO default "pretend"
 * provider — a deployment without a configured channel refuses.
 *
 * Doctrine:
 * - NO SILENT MOCK: without a configured provider, send() raises.
 *   Test doubles are injected explicitly by tests, never defaulted.
 * - DELIVERY STATUS IS HONEST: queued ≠ sent ≠ delivered. A provider
 *   that only confirms queueing is reported as queued.
 * - CODES ARE SHORT-LIVED: expiry and attempt limits live here so no
 *   channel can accidentally mint an immortal code.
 * - PII MINIMAL: the log stores the phone hashed, never raw.
 */

export const OTP_TTL_S = 300;        // 5 minutes
export const OTP_LENGTH = 6;

export function generateCode(rng = Math.random) {
  let s = "";
  for (let i = 0; i < OTP_LENGTH; i++) s += Math.floor(rng() * 10);
  return s;
}

async function sha256Hex(msg) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export class OtpChannel {
  /* provider: { name, send(phone, message) -> {status: "queued"|"sent"|"delivered"} } */
  constructor({ provider = null } = {}) {
    this.provider = provider;
    this.log = [];
    this.issued = new Map(); // phoneHash -> { code, expiresAtMs, attempts }
  }

  configured() { return this.provider !== null; }

  async send(phone, { nowMs = Date.now(), rng } = {}) {
    if (!this.provider) {
      throw new Error(
        "no OTP provider configured — refusing to pretend to send. " +
        "Configure an SMS/USSD/tablet provider for this deployment.");
    }
    if (!phone || !phone.startsWith("+")) {
      throw new Error("OTP destination must be E.164");
    }
    const code = generateCode(rng);
    const message = `Your howUdey code is ${code}. It expires in 5 minutes.`;
    const hash = await sha256Hex(phone);
    let result;
    try {
      result = await this.provider.send(phone, message);
    } catch (err) {
      this.log.push({ phoneHash: hash, outcome: "provider-error",
                      detail: String(err), ts: nowMs });
      throw new Error(`OTP provider error: ${err.message || err}`);
    }
    const status = result && result.status;
    if (!["queued", "sent", "delivered"].includes(status)) {
      this.log.push({ phoneHash: hash, outcome: "bad-provider-status",
                      ts: nowMs });
      throw new Error(`provider returned unusable status: ${status}`);
    }
    this.issued.set(hash, { code, expiresAtMs: nowMs + OTP_TTL_S * 1000,
                            attempts: 0 });
    this.log.push({ phoneHash: hash, outcome: status, ts: nowMs,
                    provider: this.provider.name });
    return { code, status, expiresInS: OTP_TTL_S };
  }

  /* verify against the channel's own record — expiry enforced here. */
  async check(phone, code, { nowMs = Date.now() } = {}) {
    const hash = await sha256Hex(phone);
    const rec = this.issued.get(hash);
    if (!rec) return { ok: false, reason: "no-code-issued" };
    rec.attempts += 1;
    if (rec.attempts > 5) {
      this.issued.delete(hash);
      return { ok: false, reason: "too-many-attempts" };
    }
    if (nowMs > rec.expiresAtMs) {
      this.issued.delete(hash);
      return { ok: false, reason: "expired" };
    }
    if (String(code) !== rec.code) return { ok: false, reason: "mismatch" };
    this.issued.delete(hash); // one-time
    return { ok: true };
  }

  auditLog() { return this.log.map(e => ({ ...e })); }
}
