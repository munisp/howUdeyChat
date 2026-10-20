// sign.js — shared HMAC-SHA256 signing on platform WebCrypto (node + browser).
// Nothing hand-rolled: importKey("HMAC") + sign/verify, hex encoding.
// Used by actions, consent-gate, verify (staff badges) and bulletin.

const te = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export const hex = {
  enc: (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join(""),
};

async function hmacKey(keyBytes) {
  return subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// canonical JSON: stable key order so signatures verify across platforms.
export function canon(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canon).join(",") + "]";
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canon(obj[k])).join(",") + "}";
}

export async function hmacSign(payloadObj, keyBytes) {
  const key = await hmacKey(keyBytes);
  const sig = await subtle.sign("HMAC", key, te.encode(canon(payloadObj)));
  return hex.enc(new Uint8Array(sig));
}

export async function hmacVerify(payloadObj, sigHex, keyBytes) {
  const key = await hmacKey(keyBytes);
  const bytes = Uint8Array.from(sigHex.match(/../g).map((h) => parseInt(h, 16)));
  return subtle.verify("HMAC", key, bytes, te.encode(canon(payloadObj)));
}

export async function newKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}
