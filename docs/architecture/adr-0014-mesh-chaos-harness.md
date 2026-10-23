# ADR-0014: Mesh chaos harness — the wild, injected in-process

## Context

The relay mesh exists for degraded reality: rainy-season backhaul, a peer
relay on a motorbike hotspot, packets dropped, duplicated, reordered. Until
now its correctness properties were tested only on a well-behaved
transport. A chaos harness against a real WAN needs networked multi-node
infrastructure we do not have in the sandbox — but the mesh's transport is
an injectable seam (`postFn`), so the wild can be injected in-process.

## Decision

`relay/chaos_mesh_test.go` wraps the intake sink with a seeded chaos
transport and asserts doctrine under four failure shapes:

| Failure shape | Injection | Pinned property |
|---|---|---|
| Drops (40%) | transport randomly errors; Drain stops at first failure | retry loop lands **all** 300 entries — zero loss; entries that fail stay spooled |
| Duplicates (50%) | retry-that-actually-succeeded delivers twice | 52 second-copies delivered, **all refused** at intake dedupe; acceptance of a dupe fails the harness itself |
| Reordering | buffered, shuffled delivery | full set lands; dedupe is by txn id, final replay order comes from spool queued-at ordering, not arrival order |
| Tamper mid-storm | body edited, hash kept | quarantined while its 9 honest neighbours land |

Load doctrine applies: timings are recorded, never asserted. Each test
also asserts the chaos actually fired (a spike with zero drops would
prove nothing and now says so).

## Honest limits

- ~~This is **in-process** chaos~~ **Update (same day)**: `chaos_wire_test.go`
  now runs the same assertions over **real TLS sockets** (httptest servers)
  with a RoundTripper injecting 10–60ms latency and 25% dial failures:
  zero loss over 56 round trips with 16 tower failures, slow-peer drains
  without duplication, duplicate wire deliveries refused (400), tampered
  bytes rejected at the TLS endpoint. Timings recorded, never asserted.
- Latency is not injected (the transport is synchronous); the drops test
  exercises the retry path instead, which is where latency pressure
  actually lands in this design.
- What genuinely remains for connected infrastructure: multi-host clock
  skew, true mid-stream packet loss, and real PKI (tests use self-signed
  loopback certs). Those need network namespaces or real machines.

## Consequences

The mesh's core claims — no silent loss, no accepted duplicates,
tamper quarantined even mid-storm, queue order preserved across retry —
are now executable tests, not assertions in a design doc. Run:
`go test -run Chaos -v ./relay/`.
