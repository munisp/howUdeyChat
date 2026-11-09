/* wagateway.js — WhatsApp Business Cloud API gateway adapter.
 *
 * Strategy: meet users where they are. Community members who stay on
 * WhatsApp receive the platform's messages through the official Business
 * Cloud API; field officers use the sovereign client. The gateway maps
 * WhatsApp delivery states onto the platform's honesty doctrine:
 * delivered ≠ read ≠ understood.
 *
 * Doctrine:
 * - HONEST SPIKE: without WHATSAPP_TOKEN / WHATSAPP_PHONE_ID, every
 *   send refuses loudly (no silent mock success).
 * - WEBHOOK SIGNATURES VERIFIED: inbound status updates are accepted
 *   only with a valid X-Hub-Signature-256 over the raw body; a bad
 *   signature is quarantined, not processed.
 * - STATUS TRUTH: "sent" is Meta acknowledging receipt, "delivered" is
 *   the device, "read" is the person opening it. The adapter never
 *   upgrades one into another.
 * - TEMPLATES ONLY for business-initiated messages (Meta's rule): the
 *   adapter refuses free-form sends outside a 24h session window —
 *   pass sessionOpen=true only when the user messaged us first.
 */

export const WAGATEWAY_VERSION = "wagateway@1.1.0";

const API_BASE = "https://graph.facebook.com/v21.0";

/* Status monotonicity: sent < delivered < read. A webhook that tries to
 * walk the ladder backwards is an anomaly — recorded, never applied.
 * "failed" is terminal and out of the ladder: it never becomes sent. */
const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };

export class WAGateway {
  /* config: { token, phoneId, appSecret, fetchImpl } — fetchImpl
   * injectable for tests. */
  constructor(config = {}) {
    this.token = config.token || null;
    this.phoneId = config.phoneId || null;
    this.appSecret = config.appSecret || null;
    this.fetchImpl = config.fetchImpl || null;
    this.outbound = [];     // sent message records
    this.statuses = [];     // verified status updates
    this.quarantine = [];   // rejected webhooks, fail-loud
    this.anomalies = [];    // backwards status walks, recorded not applied
    this._seenStatus = new Map();  // "wamid:status" -> ts (webhook dedupe)
    this.templates = null;  // optional TemplateRegistry (bind via useTemplates)
    this.tier = null;       // optional MessagingTier (bind via useTier)
  }

  ready() {
    return Boolean(this.token && this.phoneId);
  }

  _requireReady() {
    if (!this.ready()) {
      throw new Error(
        "WhatsApp gateway not configured (token + phone id required) " +
        "— refusing loudly rather than pretending to send");
    }
    if (!this.fetchImpl) {
      throw new Error("no fetch implementation available");
    }
  }

  /* Bind a TemplateRegistry: from now on every template send checks the
   * template is ratified for the requested language. Unbinding is not
   * offered — a bound gateway never silently goes ungoverned. */
  useTemplates(registry) {
    if (this.templates) throw new Error("template registry already bound");
    this.templates = registry;
  }

  /* Bind a MessagingTier: sends beyond the declared 24h unique-recipient
   * cap refuse with the tier named, instead of being rejected by Meta
   * mid-campaign. */
  useTier(tier) {
    if (this.tier) throw new Error("messaging tier already bound");
    this.tier = tier;
  }

  async sendTemplate(to, templateName, { lang = "en", params = [],
                                         sessionOpen = false, headerMediaId = null } = {}) {
    this._requireReady();
    if (!to || !to.startsWith("+")) {
      throw new Error("recipient must be E.164");
    }
    if (!templateName && !sessionOpen) {
      throw new Error(
        "business-initiated messages must be approved templates " +
        "(Meta policy); sessionOpen=true only within 24h of the user " +
        "messaging us first");
    }
    if (templateName && this.templates) {
      this.templates.assertSendable(templateName, lang);
    }
    if (this.tier) {
      this.tier.noteRecipient(to);   // throws with the tier named at cap
    }
    const components = params.length
      ? [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p) })) }]
      : [];
    if (headerMediaId) {
      components.unshift({ type: "header",
        parameters: [{ type: "image", image: { id: headerMediaId } }] });
    }
    const body = {
      messaging_product: "whatsapp",
      to: to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: templateName,
        language: { code: lang },
        components,
      },
    };
    const resp = await this.fetchImpl(
      `${API_BASE}/${this.phoneId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`,
                   "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`WhatsApp send failed: HTTP ${resp.status} ${detail}`);
    }
    const data = await resp.json();
    const rec = { to, template: templateName,
                  wamid: data.messages?.[0]?.id || null,
                  status: "sent", ts: Date.now() };
    this.outbound.push(rec);
    return rec;
  }

  /* Verify and ingest a status webhook. rawBody must be the exact raw
   * bytes; signature from X-Hub-Signature-256 ("sha256=..."). */
  async ingestStatusWebhook(rawBody, signature) {
    if (!this.appSecret) {
      throw new Error("app secret required for webhook verification");
    }
    const expected = "sha256=" + await hmacHex(
      new TextEncoder().encode(this.appSecret), rawBody);
    if (signature !== expected) {
      this.quarantine.push({ reason: "bad-signature", ts: Date.now() });
      throw new Error("webhook signature mismatch — quarantined");
    }
    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { throw new Error("webhook body not JSON"); }
    const statuses = [];
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        for (const st of change.value?.statuses || []) {
          const dedupeKey = `${st.id}:${st.status}`;
          if (this._seenStatus.has(dedupeKey)) {
            // Meta retries webhooks; a retry is an ack, not a new fact.
            statuses.push({ wamid: st.id, status: st.status, deduped: true });
            continue;
          }
          this._seenStatus.set(dedupeKey, Date.now());
          const rec = { wamid: st.id, status: st.status,
                        recipient: st.recipient_id,
                        ts: Number(st.timestamp) * 1000 };
          this.statuses.push(rec);
          statuses.push(rec);
          const out = this.outbound.find(o => o.wamid === st.id);
          if (out) {
            const anomaly = () => this.anomalies.push(
              { wamid: st.id, from: out.status, to: st.status, ts: Date.now() });
            if (out.status === "failed") {
              anomaly();                   // failed is terminal
            } else if (st.status === "failed") {
              if (out.status === "sent") out.status = "failed";
              else anomaly();              // delivered/read never "fails"
            } else if ((STATUS_RANK[st.status] || 0) >= (STATUS_RANK[out.status] || 0)) {
              out.status = st.status;      // sent -> delivered -> read only
            } else {
              anomaly();                   // backwards walk recorded
            }
          }
        }
      }
    }
    return statuses;
  }

  /* Media upload (template headers, image documents). Returns the
   * media_id; the id is Meta-side state, stated as such. */
  async uploadMedia(bytes, mimeType, filename = "upload.bin") {
    this._requireReady();
    if (!bytes || !bytes.length) throw new Error("empty media refuses");
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    const resp = await this.fetchImpl(`${API_BASE}/${this.phoneId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`WhatsApp media upload failed: HTTP ${resp.status} ${detail}`);
    }
    const data = await resp.json();
    if (!data.id) throw new Error("media upload returned no id — stated, not guessed");
    return data.id;
  }

  /* The honesty report: funnel counts, and the gap between delivered
   * and read is always visible. */
  report() {
    const count = s => this.outbound.filter(o => o.status === s).length;
    return {
      sent: count("sent"),
      delivered: count("delivered"),
      read: count("read"),
      failed: count("failed"),
      quarantinedWebhooks: this.quarantine.length,
      anomalies: this.anomalies.length,
      note: "delivered ≠ read ≠ understood — the gaps are the report",
    };
  }
}

/* ------------------------------------------------ template registry
 * Meta requires business-initiated templates to be approved. The
 * registry is the platform-side governance of that: a template is
 * proposed by one hand and approved by another (the hand that proposes
 * never approves), per-language variants are tracked, and a send of an
 * unratified template refuses before it reaches Meta — a rejected
 * template at Meta is a quality-rating wound, caught here first. */

export const TEMPLATE_STATES = Object.freeze(
  ["draft", "submitted", "approved", "rejected"]);

export class TemplateRegistry {
  constructor() { this.templates = new Map(); }   // name -> record

  propose(name, def, { by } = {}) {
    if (!name) throw new Error("template name required");
    if (!by) throw new Error("proposer must be named");
    if (this.templates.has(name)) {
      throw new Error(`template ${name} exists — version it, don't overwrite`);
    }
    const langs = def.langs || {};
    if (!Object.keys(langs).length) {
      throw new Error("a template with no language variant is not a template");
    }
    for (const [lang, body] of Object.entries(langs)) {
      if (!body || !String(body).trim()) {
        throw new Error(`template ${name}/${lang}: empty body`);
      }
    }
    this.templates.set(name, {
      name, langs: { ...langs }, category: def.category || "UTILITY",
      state: "draft", proposedBy: by, approvedBy: null, history: [
        { at: Date.now(), by, action: "propose" }] });
    return this.templates.get(name);
  }

  _setState(name, state, by) {
    const t = this.templates.get(name);
    if (!t) throw new Error(`unknown template ${name}`);
    t.state = state;
    t.history.push({ at: Date.now(), by, action: state });
    return t;
  }

  markSubmitted(name, { by } = {}) { return this._setState(name, "submitted", by); }
  markRejected(name, { by } = {}) { return this._setState(name, "rejected", by); }

  approve(name, { by } = {}) {
    const t = this.templates.get(name);
    if (!t) throw new Error(`unknown template ${name}`);
    if (!by) throw new Error("approver must be named");
    if (t.proposedBy === by) {
      throw new Error("the hand that proposes never approves");
    }
    t.approvedBy = by;
    return this._setState(name, "approved", by);
  }

  assertSendable(name, lang) {
    const t = this.templates.get(name);
    if (!t) throw new Error(`unknown template ${name} — not in the registry`);
    if (t.state !== "approved") {
      throw new Error(`template ${name} is ${t.state} — only approved templates send`);
    }
    if (!t.langs[lang]) {
      throw new Error(`template ${name} has no ${lang} variant — stated, not improvised`);
    }
    return t;
  }
}

/* ------------------------------------------------ messaging tier
 * Meta caps business-initiated conversations per rolling 24h by tier
 * (1k / 10k / 100k / unlimited unique customers). The deployment
 * declares its tier; the gateway refuses at the cap with the tier
 * named, instead of discovering the cap as a Meta error mid-campaign. */

export const MESSAGING_TIERS = Object.freeze({
  "tier-1k": 1000, "tier-10k": 10000, "tier-100k": 100000,
  "tier-unlimited": Infinity,
});

export class MessagingTier {
  constructor(tierName, { now = () => Date.now() } = {}) {
    if (!(tierName in MESSAGING_TIERS)) {
      throw new Error(`unknown messaging tier ${tierName} — declared tiers only`);
    }
    this.tierName = tierName;
    this.cap = MESSAGING_TIERS[tierName];
    this.now = now;
    this.window = new Map();   // recipient -> first-seen ts (rolling 24h)
  }

  _prune() {
    const cutoff = this.now() - 24 * 3600 * 1000;
    for (const [to, ts] of this.window) if (ts < cutoff) this.window.delete(to);
  }

  noteRecipient(to) {
    this._prune();
    if (!this.window.has(to)) {
      if (this.window.size >= this.cap) {
        throw new Error(
          `messaging tier ${this.tierName} cap reached (${this.cap} unique ` +
          "recipients/24h) — upgrade the tier or wait for the window; " +
          "the cap is stated, never discovered mid-campaign");
      }
      this.window.set(to, this.now());
    }
    return this.window.size;
  }

  headroom() { this._prune(); return this.cap - this.window.size; }
}

async function hmacHex(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
