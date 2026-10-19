// store-idb — IndexedDB-backed Store for the PWA and the Capacitor shells.
// Everything the patient sees or sends survives app kill, airplane mode, and
// battery pull. Same contract as store-memory.js.
const DB_NAME = "howudeychat";
const DB_VERSION = 1;

export class IdbStore {
  constructor() { this._db = null; }

  async _open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("kv");                       // sync token, settings
        db.createObjectStore("events", { keyPath: "event_id" });
        db.createObjectStore("rooms", { keyPath: "roomId" });
        db.createObjectStore("outbox", { keyPath: "txnId" });
        db.createObjectStore("media", { keyPath: "mxc" }); // offline blob cache
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  }

  _tx(store, mode, fn) {
    return this._open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    }));
  }

  async getSyncToken() { return this._tx("kv", "readonly", (s) => s.get("syncToken")); }
  async setSyncToken(t) { return this._tx("kv", "readwrite", (s) => s.put(t, "syncToken")); }
  async hasEvent(id) { return (await this._tx("events", "readonly", (s) => s.get(id))) !== undefined; }
  async putEvent(roomId, ev) { return this._tx("events", "readwrite", (s) => s.put({ ...ev, roomId })); }
  async roomEvents(roomId) {
    const all = await this._tx("events", "readonly", (s) => s.getAll());
    return (all || []).filter((e) => e.roomId === roomId);
  }
  async touchRoom(roomId) { return this._tx("rooms", "readwrite", (s) => s.put({ roomId, ts: Date.now() })); }
  async listRooms() {
    const all = await this._tx("rooms", "readonly", (s) => s.getAll());
    return (all || []).map((r) => r.roomId);
  }
  async outboxAdd(msg) { return this._tx("outbox", "readwrite", (s) => s.put(msg)); }
  async outboxRemove(txnId) { return this._tx("outbox", "readwrite", (s) => s.delete(txnId)); }
  async outboxAll() { return (await this._tx("outbox", "readonly", (s) => s.getAll())) || []; }
  async mediaGet(mxc) { return this._tx("media", "readonly", (s) => s.get(mxc)); }
  async mediaPut(mxc, blob, mime) { return this._tx("media", "readwrite", (s) => s.put({ mxc, blob, mime })); }
}
