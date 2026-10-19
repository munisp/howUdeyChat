# ADR-0002: Polyglot core — TypeScript, Go, Rust, Python

- Status: accepted
- Date: 2026-10-20

## Decision

Each language does the job it is best at, over network or file boundaries —
never a monolith:

| Component | Language | Why |
|---|---|---|
| `packages/matrix-lite` | TypeScript/JavaScript (ES modules) | Runs natively in the PWA and both Capacitor shells with zero build step; the client surface is small enough to own. `.d.ts` types document the contract. |
| `apps/pwa` | JavaScript + service worker | The one UI codebase for Android, iOS, and browser. |
| `relay/` | Go (std lib only) | Store-and-forward relay at clinic hotspots / LGA hubs: goroutines + `net/http` are exactly right for a network appliance; matches openhealthOS platform tooling. |
| `core/huc-core` | Rust (pure std) | The crypto/util pieces that must be exactly right (SHA-256, HMAC, constant-time compare, envelope hashing) written once, fuzzable, auditable, zero-dependency so it builds offline forever. Consumed natively by tooling; the same envelope hash is re-implemented in Go where the relay needs it (verified by cross-test). |
| `demo/`, `tests` | Python + Node | Python for network-condition simulation (the honest way to demo "works on 2G"); Node for client-core unit tests. |

## Rules

- No component may gain a dependency that pulls BSL/SSPL/Elastic-licensed
  code. Current count of third-party runtime dependencies: **zero**
  (Capacitor, Apache-2.0, is the only planned one, at the shell boundary).
- Every language boundary is a tested contract, not a hope.
