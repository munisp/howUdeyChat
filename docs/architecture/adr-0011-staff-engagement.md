# ADR-0011: Staff engagement — escalation queue, staff provisioning, console

Status: accepted
Date: 2026-10-20

## Context

ADR-0010 provisioned *patients*. But care needs the other side: a nurse or
doctor must be able to engage a patient directly — when the triage bot is out
of its depth, when a patient asks for a human, or for scheduled follow-ups.
Staff identity cannot be self-asserted any more than patient identity can:
a "doctor" on the platform must be a doctor in the professional registry.

## Decision

**Staff provisioning** (extends `admin/`): `POST /v1/staff/provision` is gated
against the staff registry (licence number + role + phone must all match the
registered record — MDCN for doctors, NMCN for nurses, CHW rosters). Roles are
a closed set: `doctor | nurse | chw | admin`. Activation is the same
fail-closed, single-use-code flow as patients (`/v1/staff/activate`), and a
patient account cannot activate through the staff path or vice versa.

**Escalation queue**: `POST /v1/escalate` (patient app or gateway bot) opens
an escalation bound to the patient's Matrix room — idempotent per room, and
only for known, non-revoked accounts (no phantom queue entries). Staff poll
`GET /v1/queue`; `POST /v1/queue/claim` is first-come-first-served (a second
staff member gets 409, never a silent takeover); only the claimer can
`POST /v1/queue/resolve`. The queue persists to disk and survives restarts.

**Staff console** (`apps/console/`): a minimal web app on the same
matrix-lite core as the patient app — sign in with staff credentials, see the
waiting queue, claim a patient, chat in their room (text, artifacts, voice/
video via the same CallManager), resolve. First-class proof that staff and
patients are just users on the same homeserver: engagement is a room, not a
feature.

## Consequences

- The full care loop is sovereign: patient ↔ triage bot ↔ human clinician,
  all on self-hosted Matrix, no third-party transport.
- Licence-gated provisioning means "doctor" is a verified claim, not a
  display name.
- Claim semantics give a clean on-duty handoff model: first claim wins,
  ownership is visible, only the owner resolves.
- The console reuses matrix-lite verbatim — zero new client code to audit.
- Room-access policy (which staff may enter which clinic's rooms) remains
  deployment configuration on the homeserver; the admin service records roles
  but does not yet enforce per-room ACLs.
