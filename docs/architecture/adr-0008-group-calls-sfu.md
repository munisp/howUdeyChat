# ADR-0008: Group calls via operator SFU (phase 3)

- Status: accepted
- Date: 2026-10-20

## Context

1:1 calls (ADR-0006) mesh fine at two parties. A care-team consult — doctor,
nurse, patient, interpreter, CHW — cannot mesh: clinic upload bandwidth is
the bottleneck, and every additional peer multiplies it. WhatsApp handles
this with Meta's SFUs; we need the same shape under operator control.

## Decision

MSC3401-shaped group calls in `packages/matrix-lite/group-calls.js`:

- **The room is the call.** Participants publish `m.call.member` state
  events; anyone in the room sees the call and joins. No invites to lose on
  a flaky link — state converges.
- **SFU focus is an injected seam.** Reference: self-hosted LiveKit
  (Apache-2.0) run by the operator. The client knows only the
  `FocusFactory` interface; tests use a fake.
- **Deterministic focus agreement**: the lexicographically-lowest member's
  focus wins — every participant computes the same answer independently,
  no leader election on a dead network.
- **TURN is operator config** (ADR-0006 rationale: CGNAT is the default).
- Media client↔SFU is DTLS-SRTP (WebRTC native). The SFU is the honest
  trust boundary: it forwards media, so it can see it — it is the
  operator's own server, documented in SECURITY.md. Full-mesh E2EE group
  media (insertable streams) is a future hardening note.

## Excluded

PSTN bridging, call recording (clinical governance, not engineering),
webinar-scale rooms (>50 participants — a different product).
