# ADR-0003: Offline-first, rich content, zero-tile maps

- Status: accepted
- Date: 2026-10-20

## Decision

**Queue-first sending.** Every outbound message — text, photo, voice note,
location — is written to a durable outbox (IndexedDB on client, disk spool
on the relay) *before* any network attempt. Transaction IDs make retries
idempotent. `send()` never fails because the network did.

**Cache-first media.** An `mxc://` blob is downloaded once and served from
the device cache forever after — an x-ray the clinic sent opens in airplane
mode. Media is never cached by the service worker (freshness is
matrix-lite's job, not HTTP's).

**Rich grammar.** The channel renders `m.text`, `m.image`, `m.audio`,
`m.video`, `m.file`, `m.location`, and namespaced health artifacts
(`ng.openhealth.artifact`: appointment, prescription, facility_pin). Every
artifact carries a plain-text `body` fallback so any Matrix client shows
something useful.

**Zero-tile maps.** Locations render on a canvas with equirectangular
projection, pins, trails, and haversine distances — no tile server, no CDN,
no Google. Maps work where the network doesn't. (Same doctrine as
openhealthOS's ambulance map.)

**Service worker.** The entire app shell is precached; the app opens with
zero network. Matrix API calls bypass HTTP cache entirely.

## Verified by

`demo/offline-chat.sh` — simulated link up → down → recovery; offline queue,
ordered drain, media cache, artifact pins. `tests/` — 12 unit tests across
sync, outbox, media, artifacts, map math, i18n completeness.
