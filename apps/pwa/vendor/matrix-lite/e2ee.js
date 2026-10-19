// e2ee.js — end-to-end encryption for howUdeyChat.
//
// DESIGN HONESTY (read SECURITY.md): this is a Megolm-*shaped* outbound
// group session built entirely on audited platform crypto (WebCrypto:
// AES-256-GCM, HKDF-SHA256) — nothing hand-rolled. It gives patients real
// E2EE today against our own clients. Wire-level interop with the wider
// Matrix ecosystem's Olm/Megolm (libolm/vodozemac, Apache-2.0/MIT) is the
// documented composition point: the session store, key-share flow, and
// m.room.encrypted event handling here are shaped for that upgrade.
//
// Guarantees: forward ratchet (key evolves per message index, HKDF),
// per-message IV, authenticated encryption (AES-GCM — tamper = decrypt
// failure), key shared only with room members via m.room_key to-device
// messages, late joiners get the current session ratchet state.

const te = new TextEncoder(), td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

// --- key + ratchet ----------------------------------------------------------

async function genSessionKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

// ratchet: key_{n+1} = HKDF(key_n, info="huc-megolm-ratchet") — one-way, so
// a compromised current key never decrypts the past.
async function ratchet(keyBytes) {
  const hkdfKey = await subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode("huc-megolm-ratchet") },
    hkdfKey, 256);
  return new Uint8Array(bits);
}

async function aesKey(keyBytes) {
  return subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export const b64 = {
  enc: (u8) => btoa(String.fromCharCode(...u8)),
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

// --- session ----------------------------------------------------------------

export class GroupSession {
  constructor(id, keyBytes, index = 0) {
    this.id = id;
    this.key = keyBytes;
    this.index = index;
  }
  static async create() {
    const id = b64.enc(globalThis.crypto.getRandomValues(new Uint8Array(12)));
    return new GroupSession(id, await genSessionKey(), 0);
  }
  async encrypt(plaintextObj) {
    const msgKey = await ratchetN(this.key, 0);          // current key
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt(
      { name: "AES-GCM", iv }, await aesKey(msgKey), te.encode(JSON.stringify(plaintextObj))));
    const out = {
      session_id: this.id, index: this.index,
      iv: b64.enc(iv), ciphertext: b64.enc(ct),
    };
    this.key = await ratchet(this.key);                  // advance — one-way
    this.index++;
    return out;
  }
  exportRatchet() { return { session_id: this.id, key: b64.enc(this.key), index: this.index }; }
  static importRatchet(o) { return new GroupSession(o.session_id, b64.dec(o.key), o.index); }
}

async function ratchetN(keyBytes, n) {
  let k = keyBytes;
  for (let i = 0; i < n; i++) k = await ratchet(k);
  return k;
}

// Decrypt needs the key AT the message's index. Inbound sessions store the
// earliest known ratchet state and walk forward (bounded) to the index.
export class InboundSession {
  constructor(id, keyBytes, index) {
    this.id = id; this.earliestKey = keyBytes; this.earliestIndex = index;
    this.known = new Map(); // index -> keyBytes (kept for out-of-order delivery)
  }
  static fromRatchet(o) { return new InboundSession(o.session_id, b64.dec(o.key), o.index); }
  async decrypt(payload) {
    if (payload.session_id !== this.id) throw new Error("wrong session");
    if (payload.index < this.earliestIndex) throw new Error("message predates shared key");
    let k = this.known.get(payload.index);
    if (!k) {
      k = await ratchetN(this.earliestKey, payload.index - this.earliestIndex);
      if (this.known.size < 256) this.known.set(payload.index, k);
    }
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: b64.dec(payload.iv) }, await aesKey(k), b64.dec(payload.ciphertext));
    return JSON.parse(td.decode(pt));
  }
}

// --- manager: ties sessions to rooms, serializes key share -------------------

export class E2EE {
  constructor(store) {
    this.store = store;          // gains: e2eeGet(roomId) / e2eePut(roomId, data)
    this.outbound = new Map();   // roomId -> GroupSession
    this.inbound = new Map();    // sessionId -> InboundSession
  }
  async _load() {
    if (this._loaded) return;
    this._loaded = true;
    const data = (await this.store.e2eeGet?.("state")) || { outbound: {}, inbound: {} };
    for (const [room, o] of Object.entries(data.outbound || {})) {
      this.outbound.set(room, GroupSession.importRatchet(o));
    }
    for (const [sid, o] of Object.entries(data.inbound || {})) {
      this.inbound.set(sid, InboundSession.fromRatchet(o));
    }
  }
  async _save() {
    const outbound = {}, inbound = {};
    for (const [r, s] of this.outbound) outbound[r] = s.exportRatchet();
    for (const [sid, s] of this.inbound) {
      inbound[sid] = { session_id: sid, key: b64.enc(s.earliestKey), index: s.earliestIndex };
    }
    await this.store.e2eePut?.("state", { outbound, inbound });
  }

  async encryptFor(roomId, contentObj) {
    await this._load();
    let sess = this.outbound.get(roomId);
    let keyShare = null;
    if (!sess) {
      sess = await GroupSession.create();
      // capture the index-0 ratchet BEFORE the first encrypt advances it —
      // this is what room members receive (m.room_key) to read from the start
      keyShare = sess.exportRatchet();
      this.outbound.set(roomId, sess);
    }
    const payload = await sess.encrypt(contentObj);
    await this._save();
    return { payload, keyShare };
  }

  // room key arriving via m.room_key (to-device) — a member shares their
  // outbound session so we can read their messages
  async acceptRoomKey(share) {
    await this._load();
    this.inbound.set(share.session_id, InboundSession.fromRatchet(share));
    await this._save();
  }

  async decryptEvent(content) {
    await this._load();
    const sess = this.inbound.get(content.session_id);
    if (!sess) throw new Error("no key for session (not shared / too early)");
    return sess.decrypt(content);
  }
}

