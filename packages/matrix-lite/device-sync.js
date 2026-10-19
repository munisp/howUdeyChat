// device-sync.js — a patient's NEW phone must read their E2EE history.
// Keys never touch the server in plaintext: the old device encrypts its
// outbound session ratchets with a one-time transfer key shown as a code
// (or QR payload), and the new device decrypts locally.
//
// Envelope: AES-256-GCM via WebCrypto; transfer key = 32 random bytes shown
// base64; the wire format is a single JSON blob suitable for a QR code or a
// homeserver-backed encrypted to-device pass.

const te = new TextEncoder(), td = new TextDecoder();
const subtle = globalThis.crypto.subtle;
const b64 = {
  enc: (u8) => btoa(String.fromCharCode(...u8)),
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

export function newTransferKey() { return b64.enc(globalThis.crypto.getRandomValues(new Uint8Array(32))); }

// old device: pack all outbound session ratchets, seal with transfer key
export async function exportSessions(e2ee, transferKeyB64) {
  await e2ee._load();
  const sessions = {};
  for (const [roomId, s] of e2ee.outbound) sessions[roomId] = s.exportRatchet();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await subtle.importKey("raw", b64.dec(transferKeyB64), { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key,
    te.encode(JSON.stringify({ v: 1, sessions }))));
  return JSON.stringify({ v: 1, iv: b64.enc(iv), data: b64.enc(ct) });
}

// new device: unseal, adopt the sessions (continues the ratchet seamlessly)
export async function importSessions(e2ee, transferKeyB64, payloadJson) {
  const { iv, data } = JSON.parse(payloadJson);
  const key = await subtle.importKey("raw", b64.dec(transferKeyB64), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64.dec(iv) }, key, b64.dec(data));
  const { sessions } = JSON.parse(td.decode(pt));
  await e2ee._load();
  for (const [roomId, ratchet] of Object.entries(sessions)) {
    const { GroupSession } = await import("./e2ee.js");
    e2ee.outbound.set(roomId, GroupSession.importRatchet(ratchet));
  }
  await e2ee._save();
  return Object.keys(sessions).length;
}
