# Corridor key rotation runbook

Rotating the bilateral preshared secret on a federation corridor
without stranding in-flight messages.

## When

- Scheduled: every 90 days per corridor.
- Immediate: any suspicion of secret compromise, any peer staff
  departure with access, any unexpected `bad-mac` quarantine entries.

## Pre-flight

1. Confirm both relays are reachable: `curl -s https://<peer>/health`.
   If the peer is down, rotation can still START (dual-secret grace
   covers it), but do not call `Complete()` until the peer confirms.
2. Generate the new secret: `openssl rand -hex 32`. Transfer it to the
   peer over a DIFFERENT channel than the corridor (Signal, in person,
   sealed envelope — never email, never the corridor itself).
3. Record the rotation in the ops log with both operators named.

## Rotate (local side)

```
rp, _ := RotateCorridor(peer, newSecret, time.Now())
```

- The corridor now SENDS with the new secret and ACCEPTS both.
- Grace window: 7 days (`RotationWindow`).

## Coordinate

1. Ask the peer to cut over their send key. Watch
   `RotatingPeer.Status()`:
   - `rotating` — grace active, no old-key intakes yet.
   - `peer-still-on-old-key—contact-them` — the peer is still sending
     with the old secret; call them. This state exists so a lagging
     peer is a phone call, not an outage.
2. When the peer confirms cutover: `rp.Complete()`. The old secret is
   refused from that moment.

## If the grace expires first

After 7 days without `Complete()`, the old secret is refused and
intake answers `grace expired`. Recovery: re-run this runbook from
the top with a FRESH secret (never resurrect the expired one).

## Verify

- `go test ./relay -run Rotation` — dual-secret grace, expiry,
  cutover, and status surfacing are all covered.
- Check `Federation.Quarantine()` for `bad-mac` entries during the
  window — a spike means the peer rotated to a different secret than
  agreed; stop and re-verify out of band.

## Never

- Never rotate both corridors of a triangle (A↔B, B↔C) on the same
  day — stagger by at least 48h.
- Never store the new secret in the repo, a ticket, or chat. Ops log
  records THAT rotation happened, never the secret itself.
