/* pushlane.js — push notification lanes as registry entries.
 *
 * Push is how a field worker hears about an outbreak alert without
 * opening the app. But push in a developing-country deployment cannot
 * mean "FCM or nothing": plenty of clinic devices run de-Googled
 * Android, and a ministry that self-hosts its chat should self-host
 * its push too. So lanes are registry entries:
 *
 *   - "ntfy": self-hosted ntfy.sh-style server (Apache-2.0) — the
 *     sovereign lane; the ministry runs it next to the homeserver.
 *   - "fcm":  Firebase Cloud Messaging — present for devices that have
 *     Play services, never required.
 *
 * Doctrine:
 * - NO SILENT MOCK: an unconfigured lane refuses loudly; test doubles
 *   are injected explicitly, never defaulted.
 * - STATE TRUTH: "sent" is the push server acknowledging, "delivered"
 *   is the device confirming via the client ack hook. ntfy/FCM cannot
 *   prove delivery — the adapter never claims it.
 * - TOKENS EXPIRE: device tokens are registered with a stated TTL;
 *   sending to an expired token refuses (stale tokens are how
 *   deployments quietly lose half their fleet).
 * - PII MINIMAL: tokens are the address; message bodies stay on the
 *   chat wire — push carries a wake-up nudge and an opaque ref, never
 *   clinical content.
 */

export const PUSHLANE_VERSION = "pushlane@1.0.0";

export const LANE_KINDS = Object.freeze(["ntfy", "fcm"]);
export const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;   // 90 days, stated

export class PushRegistry {
  /* Lane configuration — four-eyes: the hand that proposes a lane
   * endpoint never ratifies it. */
  constructor() { this.lanes = new Map(); }

  proposeLane(name, def, { by } = {}) {
    if (!by) throw new Error("proposer must be named");
    if (!LANE_KINDS.includes(def.kind)) {
      throw new Error(`unknown push lane kind ${def.kind} — registry kinds only`);
    }
    if (!def.endpoint || !/^https:\/\//.test(def.endpoint)) {
      throw new Error("push endpoints are https or they do not travel");
    }
    if (this.lanes.has(name)) {
      throw new Error(`lane ${name} exists — rotate it, don't overwrite`);
    }
    this.lanes.set(name, { name, kind: def.kind, endpoint: def.endpoint,
                           ratified: false, proposedBy: by, ratifiedBy: null });
    return this.lanes.get(name);
  }

  ratifyLane(name, { by } = {}) {
    const l = this.lanes.get(name);
    if (!l) throw new Error(`unknown lane ${name}`);
    if (!by) throw new Error("ratifier must be named");
    if (l.proposedBy === by) {
      throw new Error("the hand that proposes never ratifies");
    }
    l.ratified = true;
    l.ratifiedBy = by;
    return l;
  }

  lane(name) {
    const l = this.lanes.get(name);
    if (!l) throw new Error(`unknown push lane ${name}`);
    if (!l.ratified) {
      throw new Error(`push lane ${name} is proposed, not ratified — stated`);
    }
    return l;
  }
}

export class DeviceRegistry {
  /* deviceId -> { lane, token, registeredAt, expiresAt } */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.devices = new Map();
  }

  register(deviceId, lane, token) {
    if (!deviceId || !token) throw new Error("device id and token required");
    const at = this.now();
    this.devices.set(deviceId, { lane, token, registeredAt: at,
                                 expiresAt: at + TOKEN_TTL_MS });
    return this.devices.get(deviceId);
  }

  lookup(deviceId) {
    const d = this.devices.get(deviceId);
    if (!d) throw new Error(`device ${deviceId} not registered — unknown, not guessed`);
    if (this.now() > d.expiresAt) {
      throw new Error(
        `device ${deviceId} push token expired — re-register; a stale ` +
        "token is a silent-loss machine");
    }
    return d;
  }

  sweep() {
    /* stated eviction: returns the expired device ids, removes them */
    const dead = [];
    for (const [id, d] of this.devices) {
      if (this.now() > d.expiresAt) { dead.push(id); this.devices.delete(id); }
    }
    return dead;
  }
}

export class PushLane {
  /* transport: injected fetch-like (url, opts) -> { ok, status, text() }.
   * Never defaulted: no transport, no sends — refusing loudly. */
  constructor({ registry, devices, transport = null } = {}) {
    this.registry = registry;
    this.devices = devices;
    this.transport = transport;
    this.sent = [];         // { deviceId, lane, ref, status, ts }
  }

  async nudge(deviceId, ref, { title = "New message", priority = "default" } = {}) {
    if (!this.transport) {
      throw new Error("push transport not configured — refusing loudly " +
                      "rather than pretending to notify");
    }
    if (!ref) throw new Error("a push without an opaque ref is a content leak");
    const dev = this.devices.lookup(deviceId);
    const lane = this.registry.lane(dev.lane);
    const url = lane.kind === "ntfy"
      ? `${lane.endpoint.replace(/\/$/, "")}/${encodeURIComponent(dev.token)}`
      : lane.endpoint;
    const body = lane.kind === "ntfy"
      ? { topic: dev.token, title, message: ref, priority }
      : { message: { token: dev.token,
                     notification: { title, body: ref },
                     data: { ref } } };
    const resp = await this.transport(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      const status = resp.status === 404 || resp.status === 410 ? "gone" : "failed";
      // 404/410: the token is dead — stated, so the fleet can be reaped.
      this.sent.push({ deviceId, lane: dev.lane, ref, status, ts: Date.now() });
      if (status === "gone") this.devices.devices.delete(deviceId);
      throw new Error(`push ${status}: HTTP ${resp.status} ${detail}`);
    }
    /* "sent" = the push server accepted. Delivery is the device's ack,
     * which arrives on the chat wire — never claimed here. */
    const rec = { deviceId, lane: dev.lane, ref, status: "sent", ts: Date.now() };
    this.sent.push(rec);
    return rec;
  }
}
