# ADR-0013: Patient-channel innovations — phase 7

## Status
Accepted (implemented).

## Context
ADR-0001 through ADR-0012 built the channel: Matrix core, offline-first rich
content, E2EE, calls, provisioning, staff engagement, power budgets. Phase 7
answers the next question: what makes this channel worth switching to — for a
patient, a clinic, and a ministry — beyond "a sovereign WhatsApp"? Ten
innovations, each implemented as a tested module, each carrying the platform
doctrine (fail-closed on trust, fail-soft on connectivity, honest tallies).

## Decision

| # | Innovation | Module | Why it matters |
|---|---|---|---|
| 1 | **Actionable health artifacts** | `packages/artifacts/actions.js` | Appointment cards become the decision surface: one tap confirms or reschedules; signed, idempotent envelopes consumed by the OpenHealth OS channel gateway (ADR-0038). Replays never double-book. |
| 2 | **Consent-gated messaging** | `packages/consent-gate/gate.js` | A clinician messages a patient only inside a scoped, expiring, revocable grant — checked before delivery. Fail-closed: expired, tampered, out-of-scope, wrong sender all deny. |
| 3 | **In-chat structured triage** | `packages/triage/triage.js` | Rule-based multilingual flows (fever, pregnancy danger signs) run fully on-device; red flags escalate to the staff queue (ADR-0011). Three honest outcomes only: self-care, book-a-visit, seek-care-now. Never a diagnosis. |
| 4 | **Medication adherence loops** | `packages/adherence/adherence.js` | Taken/Skipped taps become adherence events; late confirmations are honestly labelled late; snapshots ship in the exact lakefeed contract shape so OpenHealth chronic registries see real-world adherence with zero extra data entry. |
| 5 | **Verified staff identity** | `packages/verify/verify.js` | Every staff message carries an HMAC-sealed badge (licence, council, expiry) verifiable offline, printable as an HUC1 QR. Unverified senders are visibly flagged — the "Dr. Ade" WhatsApp scam pattern dies here. |
| 6 | **Care circles** | `packages/carecircle/circle.js` | Family proxy rooms with scoped, expiring grants; one level of delegation (a member can never re-invite); revocation sticks. Mirrors consent-service proxy doctrine. |
| 7 | **Targeted broadcast campaigns** | `packages/broadcast/campaign.js` | Cohort targeting by facility/LGA/programme tag for immunisation and outbreak drives; quiet hours honoured (emergencies excepted); aggregate tallies only — no per-patient read receipts leak upward. |
| 8 | **Retention shredder & panic wipe** | `packages/shredder/shredder.js` | Per-thread TTL (HIV counselling, mental health) with content-free audit; one-tap panic wipe clears messages and media cache. |
| 9 | **Offline health bulletins** | `packages/bulletin/bulletin.js` | Signed clinic notices (hours, outbreak, stock) sync opportunistically and render from cache with zero network. Forged or expired notices never display — the "free surgery Sunday" fraud pattern is blocked by signature, not by trust. |
| 10 | **Relay mesh** | `relay/mesh.go` | A stranded clinic relay hands its spool to a peer relay with a path upstream — neighbouring clinic, LGA hub on another carrier, a supervisor's laptop. HMAC hop chain; tampered payload or forged path is quarantined at intake; dedupe by txn; ordered drain. |

## Consequences
- Channel → platform: the chat client now closes clinical loops (bookings,
  adherence, triage escalation) instead of just carrying messages.
- Every trust check is signature-based and offline-capable; no innovation
  adds a network dependency to the patient device.
- Adherence events flow to OpenHealth OS registries in the existing
  lakefeed contract — no schema negotiation needed.
- Deferred: JS triage flows for more conditions (data-driven from a
  ministry-approved protocol pack), bulletin authoring UI in the staff
  console, multi-hop mesh routing (single-hop only by design today).

## Verify
`node --test tests/` (41 green, incl. phase7 suite) · `(cd relay && go test ./...)` (mesh round-trip, tamper, dedupe, ordered drain).
