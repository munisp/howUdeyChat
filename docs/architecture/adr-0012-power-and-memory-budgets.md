# ADR-0012: Power and memory budgets on the patient device

**Status:** accepted (2026-10-20)

## Context

The patient device is a budget Android phone on an unreliable grid: battery
and storage are clinical resources. A chat client that holds the radio open,
caches every photo forever, and keeps every event in memory is a chat client
that is uninstalled — and then the lab result never reaches the patient.

## Decision

howUdeyChat operates under explicit power and memory budgets, enforced in
`packages/matrix-lite` and tested in `tests/power-budget.test.mjs`:

1. **Radio is the battery.** Foreground sync long-polls start at 30s and
   grow 10s per consecutive empty sync up to 90s (`SYNC_TIMEOUT_MS` →
   `SYNC_TIMEOUT_MAX_MS`) — a quiet night costs half the wakeups of a fixed
   30s poll. Activity snaps the timeout back to 30s.
2. **Background = short polls.** `setBackground(true)` (wired to
   `visibilitychange` in the PWA, inherited by the Capacitor shells) switches
   the sync loop to `timeout=0` polls every `BACKGROUND_POLL_MS` (30s). No
   request is ever held open while the app is hidden; the OS can put the
   radio to sleep between checks. Real-time delivery in the background is
   the homeserver WebPush pusher's job (already wired in Phase 3), not the
   sync loop's.
3. **Timelines are a window, not an archive.** Each room is pruned to the
   newest `TIMELINE_KEEP` (500) events, at most every 5 minutes. The
   homeserver holds the full record; the phone holds what the patient
   scrolls.
4. **Media cache is LRU with a byte cap** (`MEDIA_CACHE_MAX_BYTES`, 50MB
   default). `downloadCached` enforces the budget after every insert; a
   viewed blob counts as recently used. ~6 months of thumbnails and clinic
   documents fit on a 32GB device without the app ever being the reason
   storage ran out.
5. **Parked ciphertext is bounded.** The undecryptable-events map caps at
   500 entries, oldest evicted — history on the server is the fallback, not
   an in-memory leak.
6. **Telemetry hooks.** `client.onTelemetry(metric, value)` reports
   background polls, prune counts, evictions — the admin service can roll
   these up (opt-in, clinical-detail-free) to prove the budget holds on
   real devices.

## Consequences

- Budgets are constants in one file (`client.js`), not folklore in a wiki.
- Tests pin the behaviour: background polls never long-poll, idle growth
  caps, LRU eviction order, prune keeps the newest.
- Existing behaviour is unchanged for foreground active use: the first sync
  is always a 30s long-poll, sends still flush immediately.
- The staff console (`apps/console`) is a desktop tool on mains power and
  keeps its 3s queue poll deliberately.
