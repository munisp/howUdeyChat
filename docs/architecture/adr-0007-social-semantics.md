# ADR-0007: Social semantics — reactions, redaction, receipts, typing (phase 2)

- Status: accepted
- Date: 2026-10-20

## Decision

The client gains the four social primitives that matter in care, all over
the standard Matrix endpoints:

- **Reactions** (`m.reaction` annotation) — a 👍 from the clinic is a
  triage signal; cheaper than a message on a 2G link.
- **Redaction** (`/redact`) — delete a message sent in error. In a health
  context this is a safety feature (misdirected results), with an operator-
  visible audit trail on the homeserver, not a disappearing act.
- **Read receipts** (`m.read`) — the clinic sees the patient *saw* the
  appointment card. Delivery certainty matters more than read privacy here.
- **Typing notifications** — presence signal for live triage conversations.

## Deliberately excluded

Stories/status broadcasts, sticker packs, and public channels — engagement
mechanics that add bandwidth cost and clinical risk without treating anyone.
howUdeyChat is care infrastructure, not a social network.
