# ADR-0016 — Universal client: federation, identity, gateway, voice

Status: accepted (2026-11-01)

## Context

ADR-0015 generalized the structured seam into domain packs, making
howUdeyChat a multi-sector client. Four pieces remained between
"domain-capable" and "universal client": relays of different sovereign
deployments couldn't exchange traffic; there was no phone-number
identity and discovery; users who stay on WhatsApp were unreachable;
and low-literacy users had no voice-first message type.

## Decision

1. **Relay federation** (`relay/federation.go`): bilateral corridors
   between deployments. Each peer pair has its own preshared secret;
   entries carry an origin path; loops, unknown peers, bad MACs, and
   sender mismatches are quarantined with reasons, never forwarded.
   Federation is a corridor guarantee, not trust — the receiving
   deployment still applies its own intake rules.

2. **Phone identity with private discovery** (`packages/identity/`):
   E.164 normalization (Nigerian local default), OTP-verified
   registration (fail-closed), and hash-based contact discovery —
   the directory stores HMAC(phone, salt) for opted-in users only,
   answers queries but can never be listed, and rate-limits
   enumeration attempts loudly.

3. **WhatsApp Business gateway** (`packages/wagateway/`): official
   Cloud API adapter. Honest spike — unconfigured sends refuse
   loudly; template-only business-initiated sends (Meta policy);
   webhook signatures verified with quarantine on mismatch; status
   ladder kept honest (sent ≠ delivered ≠ read).

4. **Voice notes** (`packages/voicenote/`): first-class m.audio
   message type with duration cap, required language tag (en/pcm/ha/
   yo/ig), honest transcription states, and a low-literacy UX spec
   (hold-to-record, playback-before-send, slide-to-cancel).

## Consequences

- The same client now serves any sector (packs), any organization
  topology (federation), any user (phone identity + WhatsApp gateway),
  and any literacy level (voice notes).
- Trust boundaries are explicit everywhere: corridors, opt-in
  discovery, verified webhooks, honest transcripts.
- Remaining: production WhatsApp Business account provisioning
  (Meta-side), OTP SMS/USSD channel procurement, and inter-corridor
  key rotation runbooks.
