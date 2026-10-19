# ADR-0009: Multi-device key sync, Web Push, message editing (phase 3)

- Status: accepted
- Date: 2026-10-20

## Multi-device (device-sync.js)

A patient's new phone must read E2EE history without the server ever seeing
keys. The old device seals its outbound session ratchets under a one-time
**transfer key** (32 random bytes, shown as a code/QR), the new device
unseals locally (AES-256-GCM) and **continues the ratchet** — no re-key
storm, no history gap. Wrong key fails closed (GCM auth). Verified by test
and `demo/phase3.sh`.

## Web Push (push.js + sw.js)

When the app is closed, the operator's push gateway wakes the service
worker. **Push payloads carry no content** — a nudge to sync, nothing more;
the notification is rendered from local data after sync. Registration uses
the standard `POST /_matrix/client/v3/pushers/set`; on Android, FCM is an
optional transport and the app degrades gracefully without Play services.
Push is a bonus path, never a failure path.

## Message editing (m.replace)

Corrections in care are safety-critical ("take ONE tablet, not two").
Edits send `m.replace` with `m.new_content`; the original stays in the DAG
(homeserver audit), clients render the newest edit with an "(edited)"
marker, and a plain `* correction` fallback keeps non-rich clients honest.
Redaction (ADR-0007) remains the remove operation; editing never rewrites
history silently.
