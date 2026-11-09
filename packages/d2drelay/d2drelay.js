/* d2drelay.js — opportunistic device-to-device relay.
 *
 * A ward with zero signal is not a ward without care. Two phones that
 * meet — a CHW's and a supervisor's, an ambulance and the clinic tablet —
 * exchange what they carry, directly, no network: BLE / Nearby
 * Connections / Wi-Fi Direct are the TRANSPORTS (native, deployment-side);
 * this module is the PROTOCOL over any link shaped like
 * { send(bytes), onMessage(cb), close() }.
 *
 * Anti-entropy, honest edition:
 *  1. HELLO: both sides exchange manifests — the ids (hashes) of what
 *     they hold, with hop counts.
 *  2. WANT: each side requests exactly what it lacks.
 *  3. SERVE: payloads cross, checksummed; a corrupt payload refuses.
 *  4. HOPS BOUNDED: a message carries a hop count with a declared max —
 *     a rumor without a horizon floods the village.
 *  5. DEDUPE BY ID: re-meeting the same peer re-sends nothing.
 *
 * Doctrine: the link is injectable so chaos is testable (drops,
 * truncation, duplication); nothing here assumes the radio works.
 */

export const D2D_VERSION = "d2drelay@1.0.0";
export const MAX_HOPS = 4;          // declared horizon
export const MAX_PAYLOAD_BYTES = 512 * 1024;

async function shaHex(u8) {
  const d = await crypto.subtle.digest("SHA-256", u8);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder(), dec = new TextDecoder();

export class D2DStore {
  /* What the device carries: id -> { bytes (Uint8Array), hops } */
  constructor() { this.items = new Map(); }

  async add(bytes, hops = 0) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) {
      throw new Error("payload must be bytes — content-free relay is spam");
    }
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      throw new Error(`payload over ${MAX_PAYLOAD_BYTES} bytes refuses — ` +
                      "the clinic tablet is not a file server");
    }
    const id = await shaHex(bytes);
    if (!this.items.has(id)) this.items.set(id, { bytes, hops });
    return id;
  }

  manifest() {
    return [...this.items.entries()].map(([id, it]) => ({ id, hops: it.hops }));
  }
}

export class D2DSession {
  /* Runs one peer exchange over an injectable link. Returns a report:
   * what was offered, wanted, received, refused — all stated. */
  constructor(store, link, { maxHops = MAX_HOPS } = {}) {
    this.store = store;
    this.link = link;
    this.maxHops = maxHops;
    this.report = { offered: 0, wanted: 0, received: 0,
                    refused: [], corrupt: 0, hopLimited: 0 };
  }

  async run() {
    const myManifest = this.store.manifest();
    /* HELLO */
    await this._send({ t: "hello", manifest: myManifest });
    const hello = await this._recv("hello");
    const mine = new Set(myManifest.map(m => m.id));
    const mineHops = new Map(myManifest.map(m => [m.id, m.hops]));
    this.report.offered = hello.manifest.length;

    /* WANT what they have that we lack AND that can still travel */
    const want = hello.manifest
      .filter(m => !mine.has(m.id))
      .filter(m => m.hops + 1 <= this.maxHops)
      .map(m => m.id);
    this.report.hopLimited =
      hello.manifest.filter(m => !mine.has(m.id) && m.hops + 1 > this.maxHops).length;
    this.report.wanted = want.length;
    await this._send({ t: "want", ids: want });

    /* SERVE what they want from us */
    const theirWant = await this._recv("want");
    for (const id of theirWant.ids) {
      const it = this.store.items.get(id);
      if (!it) { this.report.refused.push({ id, reason: "wanted but not held" }); continue; }
      await this._send({ t: "item", id, hops: it.hops, body: it.bytes });
    }

    /* RECEIVE our wants */
    for (let i = 0; i < want.length; i++) {
      const msg = await this._recv("item");
      const got = msg.body instanceof Uint8Array ? msg.body : new Uint8Array(msg.body);
      const check = await shaHex(got);
      if (check !== msg.id) {
        this.report.corrupt += 1;     // checksum mismatch refuses the item
        continue;
      }
      await this.store.add(got, msg.hops + 1);
      this.report.received += 1;
    }
    await this._send({ t: "bye" });
    return this.report;
  }

  async _send(obj) {
    const body = obj.body
      ? { ...obj, body: Buffer.from(obj.body).toString("base64") }
      : obj;
    await this.link.send(enc.encode(JSON.stringify(body)));
  }

  async _recv(expectType) {
    const raw = await this.link.recv();
    let msg;
    try { msg = JSON.parse(dec.decode(raw)); }
    catch { throw new Error("peer sent unparseable frame — link is lying or dying"); }
    if (msg.t !== expectType) {
      throw new Error(`protocol violation: wanted ${expectType}, got ${msg.t}`);
    }
    if (msg.body) msg.body = new Uint8Array(Buffer.from(msg.body, "base64"));
    return msg;
  }
}

/* A link pair for tests and for the native binding to imitate:
 * wirePair gives two ends; chaos (drop probability) is injected. */
export function wirePair({ drop = 0, rng = Math.random } = {}) {
  const qa = [], qb = [];
  const endA = { send: async b => { if (rng() >= drop) qb.push(b); },
                 recv: async () => qa.shift() };
  const endB = { send: async b => { if (rng() >= drop) qa.push(b); },
                 recv: async () => qb.shift() };
  return [endA, endB];
}
