# ADR-0006: Voice/video calls (phase 2)

- Status: accepted
- Date: 2026-10-20

## Decision

`packages/matrix-lite/calls.js` — 1:1 voice/video over standard Matrix call
signaling (`m.call.invite/answer/candidates/hangup`) with WebRTC media:

- **Signaling is the product**: the state machine (idle → inviting →
  ringing → connected → ended), wire events, and glare avoidance are fully
  implemented and unit-tested with an injected fake RTC.
- **RTC is an injected seam**: browsers hand in `RTCPeerConnection` +
  `getUserMedia`; tests hand in a fake. No WebRTC code is compiled into
  logic that doesn't need it.
- **TURN is operator config** (`turnServers`): in Nigerian network reality —
  CGNAT everywhere — the operator's TURN server is what makes calls connect
  at all. Default STUN is a fallback, not a plan.
- Call events ride the same sync loop and dedupe as messages; they route
  through `onCallEvent`, never into the message store.
- E2EE of media: WebRTC encrypts media with DTLS-SRTP natively; signaling
  events in encrypted rooms inherit ADR-0005.

## Deliberately out of scope

Group calls (needs an SFU — phase 3), PSTN bridging, and call recording
(clinical governance question, not an engineering one).
