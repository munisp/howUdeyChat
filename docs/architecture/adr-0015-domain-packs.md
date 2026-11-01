# ADR-0015 — Domain packs: the seam pattern generalized

Status: accepted (2026-11-01)

## Context

The health build proved that howUdeyChat's durable advantage over
general messengers is not chat — it is *structured* messaging: NDJSON
seam lines carrying worklists in and field reports out, with
fail-closed validation on both sides (the outbreak bridge, ADR-0013's
adherence lakefeed, and the OpenHealthOS contact graph all speak this
contract). Every sector with field workers and low connectivity —
agriculture extension, cooperatives, education, logistics, civil
service — has the same shape of problem: orders in plain chat are
unstructured, unverifiable, and unauditable.

Competing with WhatsApp as a messenger is a network-effects losing
game. Competing as the *structured, offline, sovereign work layer* is
not.

## Decision

Generalize the seam into `packages/domainpack/`:

- A **domain pack** is data: `{ domain, version, inbound, outbound }`,
  where each direction declares kinds with required fields. Domain
  authors (a ministry, a coop federation, an agri-extension agency)
  ship packs; the client engine enforces the contract.
- Contract rules carried from the health build:
  - Unversioned packs and version-mismatched lines refuse.
  - Missing required fields reject loudly, batched rejections are
    counted and listed, never dropped quietly.
  - Absence is not a value: a field the event does not have is never
    emitted as a guess (the outbreak bridge's symptomatic rule).
- Seed packs: `agriculture` (field reports, market prices, extension
  worklists, advisories) and `cooperative` (dues worklists,
  contribution lines with amount+method for reconciliation, meeting
  notices, attendance).

## Consequences

- New sectors onboard by authoring a pack, not forking the app.
- Pack versions pin accountability: a contribution line always names
  the pack version that shaped it.
- Federation (relay-to-relay), phone-number identity, and voice-note
  UX remain separate, later decisions — packs are the foundation they
  hang on.
