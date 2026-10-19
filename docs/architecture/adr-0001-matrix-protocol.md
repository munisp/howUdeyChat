# ADR-0001: Matrix protocol as the transport

- Status: accepted
- Date: 2026-10-20

## Context

howUdeyChat exists because WhatsApp — the de-facto patient channel in
Nigeria — is rented ground. It can be throttled, banned, or weaponised as a
geopolitical lever; Meta's ToS is a kill switch held by a foreign
corporation. The backup channel must be: self-hostable by a state ministry
or NGO, end-to-end encryptable, federated (so states interconnect without a
central foreign operator), and operable over terrible networks.

## Decision

The transport is the **Matrix client-server protocol** (open spec,
Apache-2.0 reference homeservers: Synapse, Dendrite). We implement the
client surface **clean-room, no SDK** (~400 lines): password login,
incremental `/sync` long-poll, room send with transaction-id idempotency,
`mxc://` media download. That is the entire surface a patient client needs;
everything else is scope we refuse.

Server side we compose, we don't fork: any conforming homeserver works.
OpenHealth OS's whatsapp-gateway (ADR-0038) is the same protocol on the
clinic side, so one bot serves both WhatsApp and howUdeyChat patients.

## Consequences

- No Meta dependency anywhere in the critical path; the operator owns the
  wire, the server, and the data.
- Federation gives inter-state and NGO↔government interop for free.
- E2EE (Olm/Megolm) is available in the protocol when we choose to enable
  it — see SECURITY.md phase plan; the transport doesn't change.
