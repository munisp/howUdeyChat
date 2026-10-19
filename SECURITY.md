# Security model

howUdeyChat carries patient health conversations. The model is layered and
honest about what ships today versus what is staged.

## Layer 1 — transport (ships today)

- TLS everywhere, including clinic LANs (`allowMixedContent: false` in the
  shells). The relay may terminate a private CA for fully-offline sites.
- Bearer token per device (`m.login.password`, `device_id: HOWUDEYCHAT`).
  A lost phone = revoke one device access token on the homeserver, not the
  account.
- The relay's outage spool is integrity-protected: every entry carries an
  HMAC-SHA256 tag (huc-core, constant-time verified); a tampered spool file
  is quarantined, never relayed.

## Layer 2 — at rest (ships today)

- Events, outbox, and media live in IndexedDB inside the OS-sandboxed
  WebView; Android/iOS device encryption covers the rest.
- No message content is ever written to logs, analytics, or the service
  worker cache.

## Layer 3 — end-to-end (SHIPPED, phase 2 — ADR-0005)

- Megolm-shaped group sessions on audited platform crypto (WebCrypto
  AES-256-GCM + HKDF ratchet): the homeserver holds ciphertext only.
- Nothing hand-rolled: AES-GCM/HKDF are the platform's; the portable Rust
  envelope (AES-256-CTR + HMAC-SHA256) carries NIST test vectors.
- Wire-level interop with libolm/vodozemac Megolm is the documented
  composition point; today's guarantee is E2EE between howUdeyChat clients,
  operator-blind.
- Call media: DTLS-SRTP (WebRTC native); signaling inherits room E2EE.
- Group calls: media transits the operator's SFU (DTLS-SRTP client↔SFU).
  The SFU is the trust boundary — operator-owned, documented here; E2EE
  group media (insertable streams) is a noted future hardening.
- Multi-device: session keys move device-to-device sealed under a one-time
  transfer key; the server never sees them (ADR-0009).

## Identity

- Patients are provisioned by the clinic (account issued at registration,
  bound to their OpenHealth OS patient ID). There is no public sign-up —
  no account, no enumeration.
- The homeserver's user ID is a session handle, never an identity claim.

## Disclosure

security@openhealth.ng — 72-hour acknowledgement target.
