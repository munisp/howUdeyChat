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

const API_BASE = "https://graph.facebook.com/v21.0";

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

  async sendTemplate(to, templateName, { lang = "en", params = [],
                                         sessionOpen = false } = {}) {
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
    const body = {
      messaging_product: "whatsapp",
      to: to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: templateName,
        language: { code: lang },
        components: params.length
          ? [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p) })) }]
          : [],
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
          const rec = { wamid: st.id, status: st.status,
                        recipient: st.recipient_id,
                        ts: Number(st.timestamp) * 1000 };
          this.statuses.push(rec);
          statuses.push(rec);
          const out = this.outbound.find(o => o.wamid === st.id);
          if (out) out.status = st.status; // sent -> delivered -> read
        }
      }
    }
    return statuses;
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
      note: "delivered ≠ read ≠ understood — the gaps are the report",
    };
  }
}

async function hmacHex(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
