# ADR-0005: End-to-end encryption (phase 2)

- Status: accepted
- Date: 2026-10-20

## Context

Phase 1 shipped TLS + operator-trusted server. The gap against WhatsApp was
E2EE: even the homeserver operator shouldn't read patient messages.

## Decision

`packages/matrix-lite/e2ee.js` — Megolm-*shaped* outbound group sessions on
**audited platform crypto only** (WebCrypto AES-256-GCM + HKDF-SHA256):

- **Per-message ratchet**: key_{n+1} = HKDF(key_n) — one-way, so a
  compromised current key never decrypts the past (forward secrecy).
- **AES-256-GCM** per message with a fresh IV — tampering fails closed.
- **Key share** via `m.room_key` to-device messages; shares are queued ahead
  of ciphertext in the outbox flush, and a failed share is retried — the
  wire never carries ciphertext whose key wasn't delivered first.
- **Late/out-of-order delivery**: inbound sessions walk the ratchet forward
  (bounded, cached) — verified by test.
- **The outbox never holds cleartext** in encrypted rooms — verified by test.
- Undecryptable events are **parked, never dropped**, and retried when keys
  arrive (to-device is processed before timeline — ordering by design).
- Portable envelope cipher in `core/huc-core` (Rust, pure std):
  AES-256-CTR + HMAC-SHA256, NIST FIPS-197 / SP 800-38A vectors — for
  tooling and relay-side sealing where WebCrypto doesn't exist.

## Honesty clause

This interops with howUdeyChat clients. Wire-level interop with the wider
Matrix ecosystem's Olm/Megolm (vodozemac, MIT/Apache-2.0) is the documented
composition point: session store, key-share flow, and `m.room.encrypted`
handling here are shaped for that upgrade. We did not hand-roll primitives —
AES-GCM/HKDF are the platform's audited implementations.
