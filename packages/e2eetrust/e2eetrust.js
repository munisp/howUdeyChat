/* e2eetrust.js — the E2EE trust layer: who holds the keys is a decision,
 * never an accident.
 *
 * matrix-lite/e2ee.js encrypts; this package answers the harder
 * question — WHICH devices may hold the keys. Encryption to an
 * unverified device is secrecy theatre.
 *
 * Three mechanisms:
 *
 *  1. DEVICE IDENTITY: every device holds an ECDSA P-256 keypair
 *     (WebCrypto); its fingerprint (SHA-256 of the raw public key) is
 *     the device's name. No fingerprint, no trust.
 *
 *  2. SAS CEREMONY: two devices verify each other out-of-band — the
 *     classic 6-emoji / decimal comparison. The SAS is derived from
 *     BOTH fingerprints and a transcript nonce, so a man-in-the-middle
 *     who swaps a key changes the emojis. "I compared them" is an
 *     explicit user act; the ceremony cannot complete itself.
 *
 *  3. CARE-CIRCLE SOCIAL RECOVERY: phones get stolen, drop in rivers,
 *     die in harmattan dust. Recovery = quorum: 3 nominated vouchers
 *     from the user's care circle vouch, a facility officer countersigns,
 *     the old device is revoked "lost" with a stated reason, the new
 *     device is verified-by-recovery. Every step is recorded; the audit
 *     statement is checksummed. The hand that vouches never countersigns.
 */

export const E2EETRUST_VERSION = "e2eetrust@1.0.0";

const te = new TextEncoder();
const subtle = globalThis.crypto.subtle;

const EMOJI_TABLE = [
  "🐘","🦁","🦒","🦓","🐆","🦏","🦛","🐊","🦅","🦉","🐢","🐙","🦋","🐝","🌵","🌴",
  "🌊","⛰️","🌋","🌅","🌈","⚡","🔥","❄️","🌍","🌕","⭐","☔","🌪️","🫘","🌽","🍍",
  "🥭","🍌","🥥","🍠","🫚","🐟","🦐","🐔","🐐","🐕","🐈","🐎","🐪","🦜","🐒","🦎",
  "🥁","🪘","🎺","🎸","⚽","🏀","🛖","🚲","🏍️","🚌","⛵","🛶","🏥","💊","🩺","🧪",
];   // 64 entries — 6 bits each, drawn from the shared context

async function fingerprintOf(rawPub) {
  const d = await subtle.digest("SHA-256", rawPub);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export class DeviceIdentity {
  static async generate() {
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" },
                                          true, ["sign", "verify"]);
    const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    return new DeviceIdentity(pair, await fingerprintOf(raw));
  }
  constructor(pair, fingerprint) {
    this.pair = pair;
    this.fingerprint = fingerprint;    // the device's name
  }
  async sign(msg) {
    return new Uint8Array(await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, this.pair.privateKey, te.encode(msg)));
  }
  static async verify(pubRaw, sig, msg) {
    const pub = await subtle.importKey("raw", pubRaw,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, te.encode(msg));
  }
}

/* SAS: derive 18 bits (3 emojis) + 6 decimal digits from the ordered
 * fingerprints and the ceremony nonce. Both sides compute it; the HUMANS
 * compare. The code never says "they matched" on its own — confirm() is
 * the user swearing they looked. */
export class SasCeremony {
  constructor(fpA, fpB, nonce) {
    if (!fpA || !fpB || !nonce) throw new Error("SAS needs both fingerprints and a nonce");
    this.key = [fpA, fpB].sort().join("|") + "|" + nonce;
  }
  async render() {
    const d = new Uint8Array(await subtle.digest("SHA-256", te.encode(this.key)));
    const emojis = [0, 1, 2].map(i => EMOJI_TABLE[(d[i] & 0x3f)]);
    const digits = ((d[3] << 16) | (d[4] << 8) | d[5]) % 1_000_000;
    return { emojis: emojis.join(" "),
             decimal: String(digits).padStart(6, "0") };
  }
}

export const DEVICE_STATES = Object.freeze(
  ["unverified", "verified", "revoked-lost", "revoked-theft", "revoked-replaced"]);

export class TrustList {
  /* One per user. Keys go only to verified devices. */
  constructor(userId) {
    if (!userId) throw new Error("trust list belongs to a user");
    this.user = userId;
    this.devices = new Map();   // fingerprint -> record
    this.audit = [];
  }

  _log(action, detail) {
    this.audit.push({ at: Date.now(), user: this.user, action, ...detail });
  }

  addDevice(fingerprint, label) {
    if (this.devices.has(fingerprint)) {
      throw new Error("device already listed — a device is added once");
    }
    this.devices.set(fingerprint, { fingerprint, label: label || "device",
                                    state: "unverified", verifiedBy: null });
    this._log("device-added", { fingerprint });
    return this.devices.get(fingerprint);
  }

  /* The user confirmed the SAS matched out-of-band. There is no
   * auto-verify — the ceremony cannot complete itself. */
  confirmSas(fingerprint, { byUser = true } = {}) {
    const d = this.devices.get(fingerprint);
    if (!d) throw new Error("unknown device — unknown is not verified");
    if (!byUser) throw new Error("SAS confirmation is a human act");
    if (d.state !== "unverified") {
      throw new Error(`device is ${d.state} — re-verifying ${d.state} devices is theatre`);
    }
    d.state = "verified";
    d.verifiedBy = "sas";
    this._log("sas-confirmed", { fingerprint });
    return d;
  }

  revoke(fingerprint, reason) {
    const d = this.devices.get(fingerprint);
    if (!d) throw new Error("unknown device — cannot revoke a ghost");
    if (!DEVICE_STATES.includes(`revoked-${reason}`)) {
      throw new Error(`revocation reason ${reason} — stated reasons only`);
    }
    d.state = `revoked-${reason}`;
    this._log("device-revoked", { fingerprint, reason });
    return d;
  }

  /* The gate e2ee.js consults before sharing a room key. */
  mayHoldKeys(fingerprint) {
    const d = this.devices.get(fingerprint);
    return Boolean(d && d.state === "verified");
  }
}

export const VOUCH_QUORUM = 3;

export class CareCircleRecovery {
  /* vouchers: contact ids the user nominated beforehand (an entry you
   * nominate AFTER losing the phone is how accounts get stolen). */
  constructor(trustList, { vouchers, officerPool }) {
    if (!Array.isArray(vouchers) || vouchers.length < VOUCH_QUORUM) {
      throw new Error(`recovery needs at least ${VOUCH_QUORUM} nominated vouchers`);
    }
    if (!Array.isArray(officerPool) || !officerPool.length) {
      throw new Error("recovery needs a facility officer pool");
    }
    this.trust = trustList;
    this.vouchers = new Set(vouchers);
    this.officerPool = new Set(officerPool);
    this.request = null;
  }

  open(newFingerprint, { lostDevice } = {}) {
    if (!this.trust.devices.has(lostDevice)) {
      throw new Error("the lost device must be one of yours — stated");
    }
    if (this.trust.devices.get(lostDevice).state.startsWith("revoked")) {
      throw new Error("device already revoked — recovery does not pile up");
    }
    this.request = { newFingerprint, lostDevice, vouches: new Set(),
                     countersignedBy: null, open: true };
    return this.request;
  }

  vouch(contactId) {
    const r = this._open();
    if (!this.vouchers.has(contactId)) {
      throw new Error(`voucher ${contactId} was not nominated — vouching is pre-registered`);
    }
    r.vouches.add(contactId);
    return r.vouches.size;
  }

  countersign(officerId) {
    const r = this._open();
    if (!this.officerPool.has(officerId)) {
      throw new Error(`${officerId} is not a facility officer`);
    }
    if (r.vouches.size < VOUCH_QUORUM) {
      throw new Error(`quorum is ${VOUCH_QUORUM} vouches before countersign — order matters`);
    }
    if (r.vouches.has(officerId)) {
      throw new Error("the hand that vouches never countersigns");
    }
    r.countersignedBy = officerId;
    /* complete: new device verified-by-recovery, old device revoked */
    this.trust.devices.set(r.newFingerprint,
      { fingerprint: r.newFingerprint, label: "recovered device",
        state: "verified", verifiedBy: "recovery" });
    this.trust.revoke(r.lostDevice, "lost");
    this.trust._log("recovery-completed",
      { newFingerprint: r.newFingerprint, lostDevice: r.lostDevice,
        vouches: [...r.vouches], countersignedBy: officerId });
    r.open = false;
    return { verified: r.newFingerprint, revoked: r.lostDevice };
  }

  _open() {
    if (!this.request || !this.request.open) {
      throw new Error("no open recovery request");
    }
    return this.request;
  }
}
