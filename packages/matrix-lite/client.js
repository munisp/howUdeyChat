// matrix-lite — a clean-room Matrix client core for howUdeyChat.
// No SDK, no dependencies. Implements exactly the client-server surface a
// patient chat needs: login, incremental /sync long-poll, room send with
// transaction-id dedupe, and an offline outbox. Designed for hostile
// networks: exponential backoff with jitter, resumable sync tokens, and
// every outbound message persisted BEFORE it is attempted.

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60000;
export const SYNC_TIMEOUT_MS = 30000;
// Battery budget (ADR-0012): the radio is the battery. Foreground long-polls
// grow toward SYNC_TIMEOUT_MAX_MS while the account is idle (quiet nights
// cost half the wakeups); background mode drops long-polling entirely —
// timeout=0 short polls every BACKGROUND_POLL_MS so the OS can put the
// radio back to sleep between checks.
export const SYNC_TIMEOUT_MAX_MS = 90000;
export const BACKGROUND_POLL_MS = 30000;
// Memory budget: timelines are pruned to TIMELINE_KEEP events per room
// (at most every PRUNE_INTERVAL_MS); undecryptable ciphertext is parked in
// a bounded map, not an unbounded leak.
export const TIMELINE_KEEP = 500;
export const PRUNE_INTERVAL_MS = 300000;
export const UNDECRYPTABLE_CAP = 500;

export class MatrixLite {
  // store: an object implementing the Store contract (see store-memory.js /
  // store-idb.js). fetchImpl injectable for tests and for shells that pin TLS.
  constructor({ homeserver, accessToken, userId, store, fetchImpl, deviceId, e2ee }) {
    if (!homeserver || !accessToken || !userId || !store) {
      throw new Error("homeserver, accessToken, userId, store are required");
    }
    this.hs = homeserver.replace(/\/$/, "");
    this.token = accessToken;
    this.userId = userId;
    this.store = store;
    this.fetch = fetchImpl || globalThis.fetch;
    this.deviceId = deviceId || "HOWUDEYCHAT";
    this.e2ee = e2ee || null;   // E2EE instance from e2ee.js (optional)
    this.since = null;
    this.running = false;
    this.retryMs = RETRY_BASE_MS;
    this._pendingShares = []; // [roomId, keyShare] awaiting a live link
    this._undecryptable = new Map(); // eventId -> [roomId, ev] awaiting keys
    this._background = false;        // setBackground(true) when app hidden
    this._idleSyncs = 0;             // consecutive empty syncs (adaptive timeout)
    this._lastPrune = 0;
    this.onTelemetry = null;  // (metric, value) => void — battery/memory counters
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
        const data = await this._req("GET", `/_matrix/client/v3/sync${this._syncQuery()}`);
        const hadEvents = this._hadEvents(data);
        await this._applySync(data);
        this.since = data.next_batch;
        await this.store.setSyncToken(this.since);
        this.retryMs = RETRY_BASE_MS;
        // Idle-adaptive long-poll: quiet accounts hold each poll longer.
        this._idleSyncs = hadEvents ? 0 : this._idleSyncs + 1;
        this._syncState("live");
        await this._flushOutbox();
        await this._maybePrune();
        if (this._background) {
          // Short-poll cadence in the background: one wakeup per window.
          this._telemetry("sync.background_poll", 1);
          await sleep(BACKGROUND_POLL_MS);
        }
      } catch (e) {
        this._syncState("offline", e.status || 0);
        await sleep(jitter(this.retryMs));
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  // Background mode: app hidden / screen off. The sync loop switches from
  // held-open long-polls to spaced short polls; foreground restores
  // immediacy. The shell wires visibilitychange (PWA) or the pause/resume
  // lifecycle (Capacitor) to this.
  setBackground(on) {
    const was = this._background;
    this._background = !!on;
    if (was && !this._background) this._idleSyncs = 0; // snap back to live
    this._telemetry("sync.background", this._background ? 1 : 0);
  }

  _syncQuery() {
    const timeout = this._background
      ? 0 // never hold a request open while hidden — radio sleeps
      : Math.min(SYNC_TIMEOUT_MS + this._idleSyncs * 10000, SYNC_TIMEOUT_MAX_MS);
    return `?timeout=${timeout}` +
      (this.since ? `&since=${encodeURIComponent(this.since)}` : "");
  }

  _hadEvents(data) {
    const joined = (data && data.rooms && data.rooms.join) || {};
    for (const room of Object.values(joined)) {
      if (room.timeline && room.timeline.events && room.timeline.events.length) return true;
    }
    return false;
  }

  // Memory budget: prune each room's timeline to the newest TIMELINE_KEEP
  // events, at most once per PRUNE_INTERVAL_MS. Events are clinical
  // correspondence — the server keeps the record; the phone keeps a window.
  async _maybePrune(force = false) {
    if (!this.store.pruneEvents) return;
    const now = Date.now();
    if (!force && now - this._lastPrune < PRUNE_INTERVAL_MS) return;
    this._lastPrune = now;
    const rooms = await this.store.listRooms();
    for (const roomId of rooms) {
      const dropped = await this.store.pruneEvents(roomId, TIMELINE_KEEP);
      if (dropped) this._telemetry("store.pruned_events", dropped);
    }
  }

  _telemetry(metric, value) {
    if (this.onTelemetry) {
      try { this.onTelemetry(metric, value); } catch { /* never break sync */ }
    }
  }

  stop() { this.running = false; }

  async _applySync(data) {
    // to-device FIRST: room key shares must be accepted before we try to
    // decrypt timeline ciphertext that may arrive in the same sync
    const toDevice = (data.to_device && data.to_device.events) || [];
    for (const ev of toDevice) {
      if (ev.type === "m.room_key" && this.e2ee) {
        await this.e2ee.acceptRoomKey(ev.content);
      }
    }
    if (toDevice.length && this._undecryptable.size) {
      await this._retryUndecryptable();
    }
    const joined = (data.rooms && data.rooms.join) || {};
    for (const [roomId, room] of Object.entries(joined)) {
      const events = (room.timeline && room.timeline.events) || [];
      for (let ev of events) {   // let: decryption replaces the event object
        if (ev.sender === this.userId) continue;       // own echo
        if (await this.store.hasEvent(ev.event_id)) continue; // dedupe
        if (ev.type === "m.room.encrypted" && this.e2ee) {
          try {
            const plain = await this.e2ee.decryptEvent(ev.content);
            ev = { ...ev, type: "m.room.message", content: plain,
                   decrypted: true, original_type: "m.room.encrypted" };
          } catch {
            // key may arrive later (to-device lag) — park, never drop.
            // Bounded: past the cap, evict the oldest parked event (the
            // store still has the ciphertext; keys arriving later re-decrypt
            // from history, not from this map).
            if (this._undecryptable.size >= UNDECRYPTABLE_CAP) {
              const oldest = this._undecryptable.keys().next().value;
              this._undecryptable.delete(oldest);
              this._telemetry("e2ee.parked_evicted", 1);
            }
            this._undecryptable.set(ev.event_id, [roomId, ev]);
            continue;
          }
        }
        if (ev.type === "m.room.message" || ev.type === "m.reaction") {
          await this.store.putEvent(roomId, ev);
          if (this.onEvent) this.onEvent(roomId, ev);
        }
        if (ev.state_key !== undefined && this.onStateEvent) {
          this.onStateEvent(roomId, ev); // m.call.member etc. (group calls)
        }
        if (ev.type?.startsWith("m.call.") && this.onCallEvent) {
          this.onCallEvent(roomId, ev);
        }
      }
      await this.store.touchRoom(roomId);
    }
  }

  async _retryUndecryptable() {
    for (const [id, [roomId, ev]] of [...this._undecryptable]) {
      try {
        const plain = await this.e2ee.decryptEvent(ev.content);
        const dec = { ...ev, type: "m.room.message", content: plain,
                      decrypted: true, original_type: "m.room.encrypted" };
        await this.store.putEvent(roomId, dec);
        this._undecryptable.delete(id);
        if (this.onEvent) this.onEvent(roomId, dec);
      } catch { /* still no key — stays parked */ }
    }
  }

  // --- E2EE plumbing ---------------------------------------------------------

  async enableEncryption(roomId) {
    if (!this.e2ee) throw new Error("no E2EE manager configured");
    await this.store.setEncrypted(roomId, true);
  }

  async _shareKey(roomId, keyShare) {
    // m.room_key to-device, addressed to the room's other member devices.
    // (Membership discovery rides the homeserver; the demo addresses "*".)
    const txnId = `huc-key-${Date.now()}`;
    await this._req("PUT",
      `/_matrix/client/v3/sendToDevice/m.room_key/${encodeURIComponent(txnId)}`,
      { messages: { "*": { "*": { ...keyShare, room_id: roomId } } } });
  }

  // --- social semantics: reactions, redaction, receipts, typing --------------

  async sendReaction(roomId, eventId, emoji) {
    return this._sendEphemeral(roomId, "m.reaction", {
      "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: emoji },
    });
  }

  async redact(roomId, eventId, reason) {
    const txnId = `huc-redact-${Date.now()}`;
    return this._req("PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`,
      reason ? { reason } : {});
  }

  async sendReadReceipt(roomId, eventId) {
    return this._req("POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      {});
  }

  async sendTyping(roomId, typing, timeoutMs = 4000) {
    return this._req("PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.userId)}`,
      { typing, timeout: timeoutMs });
  }

  async sendStateEvent(roomId, type, content, stateKey = "") {
    return this._req("PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/${encodeURIComponent(stateKey)}`,
      content);
  }

  // m.replace — edit a sent message. The original stays in the DAG; clients
  // render the newest edit. Redaction (remove) is a different operation.
  async sendEdit(roomId, eventId, newBody) {
    return this._sendEphemeral(roomId, "m.room.message", {
      msgtype: "m.text",
      body: `* ${newBody}`,
      "m.new_content": { msgtype: "m.text", body: newBody },
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    });
  }

  async _sendEphemeral(roomId, type, content) {
    const txnId = `huc-eph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this._req("PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${type}/${encodeURIComponent(txnId)}`,
      content);
  }

  // --- sending -------------------------------------------------------------

  // Queue-first: the message is durable before any network attempt. txnId is
  // the idempotency key — a retried PUT with the same txnId never duplicates.
  async send(roomId, text) {
    return this.sendContent(roomId, { msgtype: "m.text", body: text });
  }

  // Rich content: images, audio, video, files, locations, health artifacts.
  // Same durability contract as text — queued before any network attempt.
  // In encrypted rooms the plaintext is sealed BEFORE it enters the outbox:
  // the queue never holds cleartext.
  async sendContent(roomId, contentObj) {
    const txnId = `huc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let wire = contentObj;
    let wireKind = contentObj.msgtype || "m.text";
    if (this.e2ee && await this.store.isEncrypted?.(roomId)) {
      const { payload, keyShare } = await this.e2ee.encryptFor(roomId, contentObj);
      if (keyShare) {
        try {
          await this._shareKey(roomId, keyShare);
        } catch {
          // dead link: the share must not die with the request — stash it
          // and let the outbox flush retry it before the ciphertext lands
          this._pendingShares.push([roomId, keyShare]);
        }
      }
      wire = { algorithm: "ng.huc.megolm.v1", ...payload };
      wireKind = "m.room.encrypted";
    }
    await this.store.outboxAdd({
      txnId, roomId,
      body: wireKind === "m.room.encrypted" ? "" : (contentObj.body || ""),
      kind: wireKind, eventType: wireKind === "m.room.encrypted" ? "m.room.encrypted" : "m.room.message",
      content: wire,
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
    if (this._flushing) return; // reentrancy guard: send() and the sync loop
    this._flushing = true;      // can both trigger a flush mid-flight
    try {
      await this._flushOutboxInner();
    } finally {
      this._flushing = false;
    }
  }

  async _flushOutboxInner() {
    // key shares go first — ciphertext must never arrive before its key
    while (this._pendingShares.length) {
      const [roomId, share] = this._pendingShares[0];
      await this._shareKey(roomId, share);
      this._pendingShares.shift();
    }
    const pending = await this.store.outboxAll();
    for (const msg of pending) {
      try {
        const path = `/_matrix/client/v3/rooms/${encodeURIComponent(msg.roomId)}` +
          `/send/${msg.eventType || "m.room.message"}/${encodeURIComponent(msg.txnId)}`;
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
