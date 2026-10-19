// matrix-lite — a clean-room Matrix client core for howUdeyChat.
// No SDK, no dependencies. Implements exactly the client-server surface a
// patient chat needs: login, incremental /sync long-poll, room send with
// transaction-id dedupe, and an offline outbox. Designed for hostile
// networks: exponential backoff with jitter, resumable sync tokens, and
// every outbound message persisted BEFORE it is attempted.

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60000;
export const SYNC_TIMEOUT_MS = 30000;

export class MatrixLite {
  // store: an object implementing the Store contract (see store-memory.js /
  // store-idb.js). fetchImpl injectable for tests and for shells that pin TLS.
  constructor({ homeserver, accessToken, userId, store, fetchImpl, deviceId }) {
    if (!homeserver || !accessToken || !userId || !store) {
      throw new Error("homeserver, accessToken, userId, store are required");
    }
    this.hs = homeserver.replace(/\/$/, "");
    this.token = accessToken;
    this.userId = userId;
    this.store = store;
    this.fetch = fetchImpl || globalThis.fetch;
    this.deviceId = deviceId || "HOWUDEYCHAT";
    this.since = null;
    this.running = false;
    this.retryMs = RETRY_BASE_MS;
    this.onEvent = null;      // (roomId, event) => void
    this.onSyncState = null;  // ("offline"|"syncing"|"live", detail) => void
    this.onSent = null;       // (txnId, eventId) => void
  }

  async _req(method, path, body) {
    const res = await this.fetch(`${this.hs}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(`matrix ${method} ${path}: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // --- sync loop -----------------------------------------------------------

  async start() {
    this.running = true;
    this.since = await this.store.getSyncToken();
    while (this.running) {
      try {
        this._syncState("syncing");
        const q = `?timeout=${SYNC_TIMEOUT_MS}` +
          (this.since ? `&since=${encodeURIComponent(this.since)}` : "");
        const data = await this._req("GET", `/_matrix/client/v3/sync${q}`);
        await this._applySync(data);
        this.since = data.next_batch;
        await this.store.setSyncToken(this.since);
        this.retryMs = RETRY_BASE_MS;
        this._syncState("live");
        await this._flushOutbox();
      } catch (e) {
        this._syncState("offline", e.status || 0);
        await sleep(jitter(this.retryMs));
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  stop() { this.running = false; }

  async _applySync(data) {
    const joined = (data.rooms && data.rooms.join) || {};
    for (const [roomId, room] of Object.entries(joined)) {
      const events = (room.timeline && room.timeline.events) || [];
      for (const ev of events) {
        if (ev.type !== "m.room.message") continue;
        if (ev.sender === this.userId) continue;       // own echo
        if (await this.store.hasEvent(ev.event_id)) continue; // dedupe
        await this.store.putEvent(roomId, ev);
        if (this.onEvent) this.onEvent(roomId, ev);
      }
      await this.store.touchRoom(roomId);
    }
  }

  // --- sending -------------------------------------------------------------

  // Queue-first: the message is durable before any network attempt. txnId is
  // the idempotency key — a retried PUT with the same txnId never duplicates.
  async send(roomId, text) {
    return this.sendContent(roomId, { msgtype: "m.text", body: text });
  }

  // Rich content: images, audio, video, files, locations, health artifacts.
  // Same durability contract as text — queued before any network attempt.
  async sendContent(roomId, contentObj) {
    const txnId = `huc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await this.store.outboxAdd({
      txnId, roomId, body: contentObj.body || "",
      kind: contentObj.msgtype || "m.text", content: contentObj,
      attempts: 0, createdAt: Date.now(),
    });
    try {
      await this._flushOutbox();
    } catch {
      // offline — the message is durable in the outbox; the sync loop's
      // recovery path flushes it. Queue-first means send() never fails
      // just because the network did.
    }
    return txnId;
  }

  async _flushOutbox() {
    const pending = await this.store.outboxAll();
    for (const msg of pending) {
      try {
        const path = `/_matrix/client/v3/rooms/${encodeURIComponent(msg.roomId)}` +
          `/send/m.room.message/${encodeURIComponent(msg.txnId)}`;
        const res = await this._req("PUT", path,
          msg.content || { msgtype: msg.kind, body: msg.body });
        await this.store.outboxRemove(msg.txnId);
        if (this.onSent) this.onSent(msg.txnId, res.event_id);
      } catch (e) {
        await this.store.outboxAdd({
          ...msg, attempts: msg.attempts + 1, lastError: e.status || 0,
        });
        throw e; // leave the rest queued; the sync loop retries on recovery
      }
    }
  }

  _syncState(state, detail) {
    if (this.onSyncState) this.onSyncState(state, detail);
  }
}

// login — password auth against any Synapse/Dendrite homeserver.
export async function login(homeserver, user, password, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const res = await f(`${homeserver.replace(/\/$/, "")}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user },
      password,
      device_id: "HOWUDEYCHAT",
      initial_device_display_name: "howUdeyChat patient device",
    }),
  });
  if (!res.ok) throw new Error(`login: HTTP ${res.status}`);
  return res.json(); // { access_token, user_id, device_id, ... }
}

function jitter(ms) { return ms + Math.floor(Math.random() * ms * 0.3); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
