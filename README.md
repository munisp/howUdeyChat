# howUdeyChat

**The sovereign patient channel** — a WhatsApp-alternative for healthcare
that a ministry, state, or NGO owns end-to-end. Not a go-to-market play:
the backup that keeps care running if WhatsApp is ever banned, throttled,
or turned into leverage against a developing country.

Android · iOS · PWA — one codebase. Offline-first. Security-first.
Speaks English, Naija (Pidgin), Hausa, Yorùbá, Igbo.

## What it does

- **Chat with your clinic** over a self-hosted [Matrix](https://matrix.org)
  homeserver (Synapse/Dendrite, Apache-2.0) — no Meta, no foreign platform
  in the critical path.
- **Rich content, not just text**: photos (x-rays, wound checks), voice
  notes, video, files, **live-style location sharing**, and structured
  health artifacts — appointment cards, prescriptions, facility pins with
  maps.
- **Zero-tile offline maps**: locations render on canvas — no tile server,
  no CDN, no Google. Maps work where the network doesn't.
- **Built for 2G and worse**: queue-first sending (durable before network),
  idempotent retries with backoff, cache-first media (a downloaded x-ray
  opens in airplane mode), the whole app shell precached.
- **Store-and-forward relay** (Go) for clinic hotspots and LGA hubs:
  patients keep chatting on the LAN when the internet drops; the relay
  spools outbound messages to disk (HMAC integrity) and replays them in
  order on recovery.
- **The clinic side already exists**: [OpenHealth OS](../openhealthOS)'s
  channel gateway (ADR-0038) speaks this same protocol, so booking,
  coverage checks, results, and wellness logging work identically on
  WhatsApp and howUdeyChat — patients migrate by installing an app, not by
  changing behaviour.

## Layout

```
packages/matrix-lite/   clean-room Matrix client core (JS/TS types, no SDK)
apps/pwa/               the app — service worker, offline shell, i18n, renderers
apps/console/           staff console — claim escalations, chat/call patients
apps/android/           Capacitor shell (build notes)
apps/ios/               Capacitor shell (build notes)
relay/                  Go store-and-forward relay (clinic hotspot / LGA edge)
admin/                  Go provisioning & management service (registration desk)
core/huc-core/          Rust crypto/util core — SHA-256, HMAC, ct-compare (pure std)
demo/                   offline-chat: e2e against a simulated Nigerian network
tests/                  node unit tests (sync, outbox, media, artifacts, i18n)
docs/architecture/      ADRs
```

## Verify it yourself

```sh
node --test tests/                 # unit tests
(cd relay && go test ./...)        # relay: spool, replay, tamper-quarantine
(cd admin && go test ./...)        # admin: provision, fail-closed activation, revoke
(cd core/huc-core && cargo test)   # crypto vectors
sh demo/offline-chat.sh            # e2e: up → down → recovery, rich content
```

## Phase 2 (shipped): closing the WhatsApp gap

- **E2EE** ([ADR-0005](docs/architecture/adr-0005-e2ee.md)): Megolm-shaped
  group sessions on WebCrypto AES-256-GCM + HKDF ratchet — the homeserver
  holds ciphertext only; key share rides `m.room_key` to-device; outbox
  never holds cleartext; out-of-order safe. Portable Rust envelope cipher
  (AES-256-CTR + HMAC, NIST vectors) in `core/huc-core`.
- **Voice/video calls** ([ADR-0006](docs/architecture/adr-0006-calls.md)):
  `m.call.*` signaling + WebRTC, TURN-configurable for CGNAT reality,
  injected-RTC seam so the state machine is fully unit-tested.
- **Social semantics** ([ADR-0007](docs/architecture/adr-0007-social-semantics.md)):
  reactions, redaction, read receipts, typing — the care-relevant ones only.
- Why Matrix and not Signal: [docs/signal-vs-matrix.md](docs/signal-vs-matrix.md)

```sh
sh demo/phase2.sh   # e2e: E2EE roundtrip, call signaling, reactions
sh demo/phase3.sh   # e2e: group calls, editing, device sync
```

## Phase 3 (shipped): scale + daily-use polish

- **Group calls** ([ADR-0008](docs/architecture/adr-0008-group-calls-sfu.md)):
  MSC3401-shaped — the room is the call, `m.call.member` state converges on
  flaky links, deterministic focus agreement, operator-run SFU seam
  (LiveKit, Apache-2.0), TURN-configured for CGNAT.
- **Call UI**: incoming-call overlay, answer/mute/video/hang-up, in all five
  languages; 1:1 calls from any thread header.
- **Multi-device** ([ADR-0009](docs/architecture/adr-0009-multi-device-push-editing.md)):
  new phone adopts E2EE sessions via a one-time transfer key (sealed
  payload, ratchet continues, wrong key fails closed).
- **Web Push**: content-free nudge → sync → render locally; optional FCM on
  Android, graceful without Play services.
- **Message editing** (`m.replace`): safety-critical corrections with audit
  trail and plain-text fallback.

## Phase 4 (shipped): provisioning & management

Patient onboarding ([ADR-0010](docs/architecture/adr-0010-provisioning-admin.md))
is clinic-assisted, end to end, in `admin/` (std-only Go):

1. **Registration desk** — operator calls `POST /v1/provision` with the patient
   ID + phone; the service verifies both against the OpenHealth registry
   (fail-closed: unknown patient or phone mismatch → 404), creates the Matrix
   account via Synapse shared-secret registration, and prints a card with
   username + one-time setup code. Only the code's SHA-256 hash is stored.
2. **Patient activates at home** — `POST /v1/activate` with username + patient
   ID + phone + setup code + chosen PIN. Every failure is the same 404 (no
   oracle); success sets the PIN with `logout_devices: true` and burns the
   code (single-use).
3. **Management** — `GET /v1/accounts`, `POST /v1/revoke` (lost phone →
   homeserver deactivation). Homeserver down? Creates/revokes spool to disk
   and replay until they land. Every action hits an append-only `audit.log`.

```sh
sh demo/admin.sh   # e2e: provision → activate → fail-closed paths → revoke
```

## Phase 5 (shipped): staff engagement

A nurse or doctor engages a patient as a peer on the same homeserver
([ADR-0011](docs/architecture/adr-0011-staff-engagement.md)):

- **Staff provisioning** — `POST /v1/staff/provision` gated against the
  professional registry: licence number + role + phone must all match
  (MDCN/NMCN/CHW rosters). Roles are a closed set (`doctor|nurse|chw|admin`);
  activation is the same fail-closed single-use-code flow as patients.
- **Escalation queue** — patient app or triage bot calls `POST /v1/escalate`;
  staff poll `/v1/queue`; first claim wins (409 for latecomers), only the
  claimer resolves. Queue persists across restarts.
- **Staff console** (`apps/console/`) — sign in, see waiting patients, claim,
  chat + voice/video call in the patient's room, resolve. Built on the same
  matrix-lite core as the patient app: engagement is a room, not a feature.

```sh
sh demo/phase5.sh   # e2e: licence gate → activate → escalate → claim → chat → resolve
```

## Phase 6 (shipped): power & memory budgets

The patient device is a budget Android phone on an unreliable grid; battery
and storage are clinical resources ([ADR-0012](docs/architecture/adr-0012-power-and-memory-budgets.md)):

- **Idle-adaptive sync** — foreground long-polls grow 30s → 90s while the
  account is quiet; activity snaps back to 30s.
- **Background short-polls** — app hidden ⇒ `timeout=0` polls every 30s
  (radio sleeps between checks); real-time background delivery rides the
  WebPush pusher, not the sync loop.
- **Timeline pruning** — newest 500 events per room, every 5 min; the
  server holds the archive, the phone holds the window.
- **Media LRU cache** — 50MB byte cap, least-recently-used evicted on every
  insert.
- **Bounded ciphertext parking** — undecryptable map capped at 500.
- **Telemetry hooks** — `onTelemetry` counters prove the budget on real
  devices (opt-in, clinical-detail-free).

```sh
node --test tests/   # 32 checks incl. the power/memory budget suite
```

## Doctrine

- **Compose, don't fork.** Homeserver is off-the-shelf Apache-2.0; our code
  is the client, the relay, and the grammar.
- **Zero third-party runtime dependencies** in the core. Capacitor
  (Apache-2.0) only at the shell boundary.
- **BSL/SSPL/Elastic-licensed code is never embedded** — re-implemented
  clean-room instead.
- **Every language boundary is a tested contract.**

Licence: Apache-2.0. See [SECURITY.md](SECURITY.md) for the security model.
