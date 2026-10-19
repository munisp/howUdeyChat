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

## Layer 3 — end-to-end (staged, not shipped)

- The Matrix protocol's E2EE (Olm/Megolm, Apache-2.0 implementations exist)
  is the planned upgrade: it encrypts room content so the *homeserver
  operator* cannot read patient messages.
- We do not hand-roll E2EE. When this lands it composes a licensed,
  audited implementation at the transport boundary — the clean-room
  matrix-lite surface is deliberately small enough to wrap.
- Until then, the honest guarantee is: TLS + operator-trusted server, and
  the operator is the ministry/NGO itself — not a foreign platform.

## Identity

- Patients are provisioned by the clinic (account issued at registration,
  bound to their OpenHealth OS patient ID). There is no public sign-up —
  no account, no enumeration.
- The homeserver's user ID is a session handle, never an identity claim.

## Disclosure

security@openhealth.ng — 72-hour acknowledgement target.
