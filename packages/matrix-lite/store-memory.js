// store-memory — in-memory Store implementation. Used by tests and by the
// demo; the PWA uses store-idb.js (IndexedDB) instead.
export class MemoryStore {
  constructor() {
    this.events = new Map();      // event_id -> { roomId, ev }
    this.outbox = new Map();      // txnId -> msg
    this.rooms = new Map();       // roomId -> lastTs
    this.media = new Map();       // mxc -> { blob, mime }
    this.encrypted = new Set();   // roomIds with E2EE enabled
    this.e2ee = new Map();        // e2ee state
    this.syncToken = null;
  }
  async getSyncToken() { return this.syncToken; }
  async setSyncToken(t) { this.syncToken = t; }
  async hasEvent(id) { return this.events.has(id); }
  async putEvent(roomId, ev) { this.events.set(ev.event_id, { roomId, ev }); }
  async roomEvents(roomId) {
    return [...this.events.values()]
      .filter((r) => r.roomId === roomId).map((r) => r.ev);
  }
  async touchRoom(roomId) { this.rooms.set(roomId, Date.now()); }
  async listRooms() { return [...this.rooms.keys()]; }
  // Memory budget (ADR-0012): drop all but the newest `keep` events in the
  // room (origin_server_ts / insertion order). Returns how many dropped.
  async pruneEvents(roomId, keep) {
    const mine = [...this.events.entries()]
      .filter(([, r]) => r.roomId === roomId)
      .sort((a, b) => (a[1].ev.origin_server_ts || 0) - (b[1].ev.origin_server_ts || 0));
    const excess = mine.length - keep;
    for (let i = 0; i < excess; i++) this.events.delete(mine[i][0]);
    return Math.max(0, excess);
  }
  async outboxAdd(msg) { this.outbox.set(msg.txnId, msg); }
  async outboxRemove(txnId) { this.outbox.delete(txnId); }
  async outboxAll() { return [...this.outbox.values()]; }
  async mediaGet(mxc) {
    const hit = this.media.get(mxc);
    if (hit) hit.at = Date.now(); // LRU touch
    return hit;
  }
  async mediaPut(mxc, blob, mime) {
    this.media.set(mxc, { blob, mime, size: (blob && blob.size) || 0, at: Date.now() });
  }
  // Media LRU contract (media.js enforceBudget): list entries with sizes
  // and last-access, delete by mxc.
  async mediaList() {
    return [...this.media.entries()].map(([mxc, v]) => ({ mxc, size: v.size, at: v.at }));
  }
  async mediaDelete(mxc) { this.media.delete(mxc); }
  async isEncrypted(roomId) { return this.encrypted.has(roomId); }
  async setEncrypted(roomId, on) { on ? this.encrypted.add(roomId) : this.encrypted.delete(roomId); }
  async e2eeGet(k) { return this.e2ee.get(k); }
  async e2eePut(k, v) { this.e2ee.set(k, v); }
}
