# ADR-0004: Nigerian languages as data, not afterthought

- Status: accepted
- Date: 2026-10-20

## Decision

All patient-facing strings live in one data module (`apps/pwa/js/i18n.js`):
English, Nigerian Pidgin (Naija), Hausa, Yorùbá, Igbo — switchable at
runtime from the header picker, persisted, applied to `<html lang>`.

Rules:

1. **No string may exist in markup or code.** If it isn't a key in `msgs`,
   it doesn't ship. A unit test asserts every language defines every key —
   a partial translation fails the build, it doesn't silently fall back.
2. **Pidgin is a first-class language**, not a joke register: "Naija" is
   the lingua franca of the ward, the market, and the danfo.
3. **Adding a language = adding one object.** The picker, persistence, and
   screens update from the same source. Kanuri, Tiv, Fulfulde, Ibibio are
   one translation volunteer away each.
4. The clinic side (openhealthOS whatsapp-gateway, ADR-0037/0038) speaks
   the same five languages over the same protocol — patient and clinic can
   each pick their own.
