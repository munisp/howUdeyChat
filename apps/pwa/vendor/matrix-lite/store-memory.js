// store-memory — in-memory Store implementation. Used by tests and by the
// demo; the PWA uses store-idb.js (IndexedDB) instead.
export class MemoryStore {
  constructor() {
    this.events = new Map();      // event_id -> { roomId, ev }
    this.outbox = new Map();      // txnId -> msg
    this.rooms = new Map();       // roomId -> lastTs
    this.media = new Map();       // mxc -> { blob, mime }
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
  async outboxAdd(msg) { this.outbox.set(msg.txnId, msg); }
  async outboxRemove(txnId) { this.outbox.delete(txnId); }
  async outboxAll() { return [...this.outbox.values()]; }
  async mediaGet(mxc) { return this.media.get(mxc); }
  async mediaPut(mxc, blob, mime) { this.media.set(mxc, { blob, mime }); }
}
