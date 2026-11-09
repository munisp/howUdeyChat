/* ussdwire.js — USSD gateway wire + session resumption.
 *
 * The USSD *engine* (menu state machines, verify-by-shortcode) lives in
 * the platform. This module is the missing wire: an aggregator adapter
 * registry plus the resumption tokens that survive the telco's 30–60s
 * session timeout.
 *
 * Aggregators are registry entries — Africa's Talking in one market,
 * a national telco direct-connect in another, an SMPP broker in a
 * third. Every entry declares its callback shape (which fields carry
 * session id / msisdn / text) so the adapter parses by configuration,
 * never by code branch.
 *
 * Doctrine:
 * - UNCONFIGURED REFUSES: no aggregator entry, no wire — stated.
 * - RESUMPTION IS A TOKEN, NOT A TRICK: when the telco drops the
 *   session, the user redials and the aggregator sends a NEW session id;
 *   the resume token (HMAC-signed, short-lived, single-use) restores
 *   the exact menu state. A forged or replayed token refuses.
 * - SINGLE-USE: a resume token is consumed on use — a session cannot
 *   be hijacked by replaying a redial.
 * - THE CLOCK IS INJECTED: expiry is testable, never wall-clock magic.
 */

export const USSDWIRE_VERSION = "ussdwire@1.0.0";
export const RESUME_TTL_MS = 10 * 60 * 1000;   // 10 minutes, stated

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export class AggregatorRegistry {
  /* name -> { fields: { sessionId, msisdn, text, resumeToken? } } */
  constructor() { this.aggs = new Map(); }

  register(name, fields) {
    for (const f of ["sessionId", "msisdn", "text"]) {
      if (!fields[f]) {
        throw new Error(`aggregator ${name}: field mapping for ${f} required`);
      }
    }
    if (this.aggs.has(name)) {
      throw new Error(`aggregator ${name} exists — rotate, don't overwrite`);
    }
    this.aggs.set(name, { name, fields: { ...fields } });
    return this.aggs.get(name);
  }

  get(name) {
    const a = this.aggs.get(name);
    if (!a) throw new Error(`unknown aggregator ${name} — no entry, no wire`);
    return a;
  }

  /* Parse a raw callback body (form-style or JSON) per the entry's
   * field mapping. */
  parse(name, body) {
    const a = this.get(name);
    const get = k => body[a.fields[k]];
    const out = { sessionId: get("sessionId"), msisdn: get("msisdn"),
                  text: String(get("text") ?? "") };
    // USSD text is the cumulative navigation chain ("1*14"); the current
    // input is the last segment. Both are exposed — the chain is the
    // audit trail, the input is what the menu consumes.
    out.input = out.text === "" ? "" : out.text.split("*").pop();
    if (!out.sessionId || !out.msisdn) {
      throw new Error(`aggregator ${name} callback missing session id or msisdn`);
    }
    if (a.fields.resumeToken && body[a.fields.resumeToken]) {
      out.resumeToken = String(body[a.fields.resumeToken]);
    }
    return out;
  }
}

export class ResumeTokenIssuer {
  /* Mints and redeems HMAC-signed resumption tokens. The token carries
   * (msisdn, menuState, expiry); redemption is single-use. */
  constructor(secret, { now = () => Date.now() } = {}) {
    if (!secret) throw new Error("resume tokens need a secret — unsigned state is a hijack");
    this.secret = secret;
    this.now = now;
    this.used = new Set();
  }

  async mint(msisdn, menuState) {
    if (!msisdn || !menuState) throw new Error("token needs msisdn and state");
    const payload = JSON.stringify({ msisdn, menuState,
                                     exp: this.now() + RESUME_TTL_MS });
    const b64 = Buffer.from(payload).toString("base64url");
    const sig = await hmacHex(this.secret, b64);
    return `${b64}.${sig}`;
  }

  async redeem(token) {
    if (this.used.has(token)) {
      throw new Error("resume token already used — single-use, replay refuses");
    }
    const [b64, sig] = String(token || "").split(".");
    if (!b64 || !sig) throw new Error("malformed resume token");
    const expected = await hmacHex(this.secret, b64);
    if (sig !== expected) throw new Error("resume token signature mismatch — forged state refuses");
    let payload;
    try { payload = JSON.parse(Buffer.from(b64, "base64url").toString()); }
    catch { throw new Error("resume token body unreadable"); }
    if (this.now() > payload.exp) {
      throw new Error("resume token expired — start the menu over, stated");
    }
    this.used.add(token);
    return payload;   // { msisdn, menuState, exp }
  }
}
