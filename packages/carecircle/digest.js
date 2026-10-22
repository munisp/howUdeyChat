// digest.js — voice-note digest scripts (care-circle feature 4).
//
// Not every sibling reads fluently. This renders the day's circle
// activity as a short spoken-language script (en + pcm) for the TTS
// layer — render-agnostic text out, audio is someone else's job.
// Honesty rules: a quiet day is reported AS a quiet day; alerts are
// read first and never softened; names, not ids, where a name map is
// given.

const STR = {
  en: {
    header: (name, date) => `Good evening ${name}. Here is today's circle report for ${date}.`,
    quiet: "No visits, no expenses, and no alerts today. Everything is quiet.",
    visit: (who) => `${who} visited.`,
    expense: (who, amt) => `${who} spent ${amt} naira.`,
    alert: (kind) => `Attention: there was an alert — ${kind}.`,
    refill: (drug, who) => `${who} has taken the task to refill ${drug}.`,
    close: "That is all for today.",
  },
  pcm: {
    header: (name, date) => `Good evening ${name}. Na today circle report for ${date} be this.`,
    quiet: "Nobody visit, nobody spend money, and no wahala today. Everywhere calm.",
    visit: (who) => `${who} go visit.`,
    expense: (who, amt) => `${who} spend ${amt} naira.`,
    alert: (kind) => `Abeg listen: alert dey — ${kind}.`,
    refill: (drug, who) => `${who} don carry the work to buy ${drug}.`,
    close: "Na all for today.",
  },
};

// script({date, member, events, lang, names}) -> spoken string.
//   events: [{kind: "visit"|"expense"|"alert"|"refill_claim", ...}]
export function script({ date, member, events = [], lang = "en", names = {} }) {
  const t = STR[lang] || STR.en;
  const who = (id) => names[id] || id;
  const lines = [t.header(who(member), date)];
  if (!events.length) lines.push(t.quiet);
  // alerts first — safety before bookkeeping, always
  for (const e of events.filter((e) => e.kind === "alert"))
    lines.push(t.alert(e.alert_kind || "check the app"));
  for (const e of events.filter((e) => e.kind !== "alert")) {
    if (e.kind === "visit") lines.push(t.visit(who(e.member)));
    else if (e.kind === "expense") lines.push(t.expense(who(e.member), e.amount));
    else if (e.kind === "refill_claim") lines.push(t.refill(e.drug, who(e.member)));
  }
  lines.push(t.close);
  return lines.join(" ");
}

export const DIGEST_LANGS = Object.keys(STR);
