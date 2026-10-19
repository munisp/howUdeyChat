# ADR-0010: Clinic-assisted provisioning & admin service

Status: accepted
Date: 2026-10-20

## Context

Patients cannot self-register: howUdeyChat accounts must be bound to a real
patient record in the OpenHealth registry, and the homeserver (Synapse) must
not be open to public sign-up. We needed an operator-facing service that
provisions accounts at the clinic registration desk, activates them
patient-side, and revokes them on loss/theft — without ever trusting the
network, the patient, or the operator more than necessary.

## Decision

A single std-only Go service (`admin/`) with four endpoints:

- `POST /v1/provision` (operator, mgmt token) — verifies the patient exists in
  the registry **and** the presented phone matches the registry record, derives
  a deterministic username (`OH-KD-0001` → `oh-kd-0001`), generates a one-time
  setup code, and creates the Matrix account via Synapse shared-secret
  registration. Only the SHA-256 hash of the code is stored.
- `POST /v1/activate` (patient, no token) — binds username + patient ID +
  phone + setup code. Every failure returns the same 404 (wrong code is
  indistinguishable from unknown account: no oracle). On success it sets the
  patient-chosen PIN as the Matrix password with `logout_devices: true` and
  **burns the code** (single use).
- `GET /v1/accounts`, `POST /v1/revoke` (operator, mgmt token) — list and
  deactivate (`deactivated: true` on the homeserver).

Fail-closed everywhere: registry unreachable → no provisioning; homeserver
unreachable → the create/revoke is **spooled** to disk and replayed by a
worker until it lands. Every mutating action is appended to an append-only
`audit.log`. Accounts persist as per-account JSON files, so a restart loses
nothing.

## Consequences

- The registration desk flow (provision → printed card with username + setup
  code → patient activates at home) works even during a homeserver outage.
- Setup codes are bearer secrets; storing only hashes plus constant-time
  comparison means a stolen database does not leak activatable codes.
- Deactivation on the homeserver is the kill switch for lost devices.
- Zero third-party dependencies: the service builds with the Go standard
  library alone, consistent with the repo's licence doctrine.
