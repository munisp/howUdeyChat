/* voicetriage.js — store-and-forward voice triage.
 *
 * A low-literacy patient doesn't fill in a triage form — they speak.
 * The voice note rides the relay like any message; when a transcript
 * exists (whisper.cpp on the relay, a staff member's summary, whatever
 * the deployment wired), this package scores it for red flags and
 * routes it into the triage queue. The original audio is ALWAYS
 * attached — a transcript is an interpretation, never the record.
 *
 * Doctrine:
 * - THE AUDIO IS THE RECORD: intake refuses without the mxc audio ref.
 * - UNTRANSCRIBED IS STATED: no transcript = priority "unscored",
 *   queued for human listen — never silently dropped, never
 *   fake-scored.
 * - RED FLAGS ARE DATA: the flag lexicon is a registry (per language);
 *   matching is exact-phrase, and the verdict names WHICH phrase fired.
 * - TRIAGE IS NOT DIAGNOSIS: outcomes are routine | book-visit |
 *   seek-care-now — the same honesty as the on-device flow.
 */

export const VOICETRIAGE_VERSION = "voicetriage@1.0.0";

export const RED_FLAG_LEXICON = Object.freeze({
  en: ["chest pain", "can't breathe", "cannot breathe", "unconscious",
       "fitting", "convulsion", "severe bleeding", "stiff neck"],
  pcm: ["e no dey breathe", "e faint", "blood dey rush", "body dey shake"],
  ha: ["ba ya numfashi", "ya suma", "jini yana zubowa"],
  yo: ["ko le miii", "o subu", "eje n san"],
  ig: ["anaghi ekusu ume", "o dara ada", "obara na-asoputa"],
});

export const PRIORITIES = Object.freeze(["emergency", "urgent", "routine", "unscored"]);

export class VoiceTriage {
  constructor({ langs = Object.keys(RED_FLAG_LEXICON) } = {}) {
    for (const l of langs) {
      if (!RED_FLAG_LEXICON[l]) throw new Error(`no red-flag lexicon for ${l} — stated`);
    }
    this.langs = langs;
    this.queue = [];
  }

  /* note: { mxc, durationS, lang, transcriptText|null } (voicenote
   * contract); patientRef is an opaque id, never a name. */
  intake(note, { patientRef } = {}) {
    if (!note || !note.mxc || !note.mxc.startsWith("mxc://")) {
      throw new Error("the audio is the record — intake refuses without it");
    }
    if (!patientRef) throw new Error("patient ref required — anonymous triage is no triage");
    if (!this.langs.includes(note.lang)) {
      throw new Error(`lang ${note.lang} has no lexicon — scored in silence is malpractice`);
    }
    const entry = { patientRef, mxc: note.mxc, lang: note.lang,
                    durationS: note.durationS, receivedAt: Date.now() };

    if (!note.transcriptText) {
      entry.priority = "unscored";
      entry.note = "no transcript — queued for human listen, stated";
      this.queue.push(entry);
      return entry;
    }
    const text = note.transcriptText.toLowerCase();
    const fired = RED_FLAG_LEXICON[note.lang].filter(p => text.includes(p));
    entry.transcriptChars = text.length;      // chars, never the text itself
    entry.flagsFired = fired;                 // WHICH phrase fired — auditable
    entry.priority = fired.length ? "emergency" : "routine";
    entry.outcome = fired.length ? "seek-care-now" : "book-visit";
    this.queue.push(entry);
    return entry;
  }

  /* The duty view: emergencies first, then unscored (a human must
   * listen), then routine. Deterministic order — received order within
   * a band. */
  dutyBoard() {
    const rank = { emergency: 0, unscored: 1, routine: 2, urgent: 1 };
    return [...this.queue].sort((a, b) => rank[a.priority] - rank[b.priority])
      .map(e => ({ patientRef: e.patientRef, priority: e.priority,
                   flagsFired: e.flagsFired || [], mxc: e.mxc }));
  }
}
