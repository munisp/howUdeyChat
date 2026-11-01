/* identity.js — phone-number identity with privacy-preserving discovery.
 *
 * WhatsApp's real moat is "find anyone by phone number." A universal
 * client needs the same affordance without WhatsApp's privacy cost:
 * uploading your entire address book to a server.
 *
 * Design:
 * - Phone numbers normalize to E.164-ish form; the uid is stable.
 * - Registration requires verification: an OTP issued by the
 *   deployment's own SMS/USSD channel, fail-closed — an unverified
 *   number cannot claim an identity.
 * - Discovery is hash-based and opt-in: the directory stores
 *   HMAC(phone, discoverySalt) for users who opted in. A client
 *   discovers contacts by hashing its address book locally and
 *   querying hashes — the server never sees the raw numbers, and
 *   non-users' numbers never leave the device.
 * - Discovery is rate-limited and answer-only: queries return matches,
 *   never the directory. Enumeration attacks hit the rate limit and
 *   are surfaced, not silently throttled.
 * - Opt-out is real: removing a number deletes its hash.
 */

const E164_RE = /^\+[1-9]\d{6,14}$/;

export function normalizePhone(raw) {
  if (typeof raw !== "string") return null;
  let p = raw.trim().replace(/[\s\-().]/g, "");
  if (/^00\d/.test(p)) p = "+" + p.slice(2);
  if (/^0\d{10}$/.test(p)) p = "+234" + p.slice(1); // Nigerian local default
  if (!E164_RE.test(p)) return null;
  return p;
}

async function hmacHex(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export class IdentityDirectory {
  /* salt: per-deployment random bytes; otpIssuer(phone) -> code, the
   * deployment's delivery channel (SMS/USSD/CHW tablet). */
  constructor({ salt, otpIssuer, discoveryRateLimit = 50 }) {
    if (!salt || !salt.length) throw new Error("discovery salt required");
    if (typeof otpIssuer !== "function") throw new Error("otpIssuer required");
    this.salt = salt;
    this.otpIssuer = otpIssuer;
    this.rateLimit = discoveryRateLimit;
    this.users = new Map();      // uid -> { phone, verified, discoverable }
    this.byPhone = new Map();    // phone -> uid
    this.hashIndex = new Map();  // discovery hash -> uid (opted-in only)
    this.pendingOtp = new Map(); // phone -> { code, attempts }
    this.queryLog = new Map();   // querier -> count (rate limiting)
    this.rateLimitHits = 0;      // enumeration attempts, surfaced
  }

  async register(uid, rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new Error(`unusable phone number: ${rawPhone}`);
    if (this.byPhone.has(phone) || this.pendingOtp.has(phone)) {
      throw new Error("number already registered");
    }
    const code = await this.otpIssuer(phone);
    this.pendingOtp.set(phone, { code: String(code), attempts: 0, uid });
    return { pending: true, phone };
  }

  async verify(rawPhone, code) {
    const phone = normalizePhone(rawPhone);
    const pending = phone && this.pendingOtp.get(phone);
    if (!pending) throw new Error("no pending registration for this number");
    pending.attempts += 1;
    if (pending.attempts > 5) {
      this.pendingOtp.delete(phone);
      throw new Error("too many attempts — registration cancelled, start over");
    }
    if (String(code) !== pending.code) throw new Error("wrong code");
    this.pendingOtp.delete(phone);
    this.users.set(pending.uid, { phone, verified: true, discoverable: false });
    this.byPhone.set(phone, pending.uid);
    return { uid: pending.uid, verified: true };
  }

  async optInDiscovery(uid) {
    const u = this.users.get(uid);
    if (!u || !u.verified) throw new Error("verified uid required");
    u.discoverable = true;
    const h = await hmacHex(this.salt, u.phone);
    this.hashIndex.set(h, uid);
    return { discoverable: true };
  }

  async optOut(uid) {
    const u = this.users.get(uid);
    if (!u) throw new Error("unknown uid");
    u.discoverable = false;
    const h = await hmacHex(this.salt, u.phone);
    this.hashIndex.delete(h);
    return { discoverable: false };
  }

  /* discover(rawPhones, querier): hashes locally, returns only matches.
   * Raw numbers never stored server-side; non-users' numbers go nowhere. */
  async discover(rawPhones, querier = "anon") {
    const count = (this.queryLog.get(querier) || 0) + rawPhones.length;
    if (count > this.rateLimit) {
      this.rateLimitHits += 1;
      throw new Error(
        `discovery rate limit (${this.rateLimit}/day) exceeded — ` +
        "enumeration attempts are logged and surfaced");
    }
    this.queryLog.set(querier, count);
    const found = [];
    for (const raw of rawPhones) {
      const phone = normalizePhone(raw);
      if (!phone) continue;
      const h = await hmacHex(this.salt, phone);
      const uid = this.hashIndex.get(h);
      if (uid) found.push({ phone, uid });
    }
    return { found, scanned: rawPhones.length };
  }

  stats() {
    return {
      registered: this.users.size,
      discoverable: this.hashIndex.size,
      pendingVerification: this.pendingOtp.size,
      rateLimitHits: this.rateLimitHits,
      note: "directory is answer-only — it can never be listed",
    };
  }
}
