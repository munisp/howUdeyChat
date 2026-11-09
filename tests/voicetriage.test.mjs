// voicetriage.test.mjs — the audio is the record; untranscribed stated;
// red flags fire by named phrase.
import { test } from "node:test";
import assert from "node:assert/strict";

import { VoiceTriage, VOICETRIAGE_VERSION } from "../packages/voicetriage/voicetriage.js";

const note = (over = {}) => ({ mxc: "mxc://hs/abc", durationS: 42, lang: "en", ...over });

test("version stamp", () => assert.equal(VOICETRIAGE_VERSION, "voicetriage@1.0.0"));

test("no audio, no intake — the audio is the record", () => {
  const vt = new VoiceTriage();
  assert.throws(() => vt.intake({ durationS: 10, lang: "en" }, { patientRef: "p1" }),
    /the audio is the record/);
  assert.throws(() => vt.intake(note()), /anonymous triage is no triage/);
  assert.throws(() => vt.intake(note({ lang: "fr" }), { patientRef: "p1" }),
    /no lexicon/);
});

test("untranscribed queues for human listen — stated, never fake-scored", () => {
  const vt = new VoiceTriage();
  const e = vt.intake(note(), { patientRef: "p1" });
  assert.equal(e.priority, "unscored");
  assert.match(e.note, /queued for human listen, stated/);
});

test("red flag fires emergency with the phrase named", () => {
  const vt = new VoiceTriage();
  const e = vt.intake(note({ transcriptText: "My son has chest pain since morning" }),
                      { patientRef: "p2" });
  assert.equal(e.priority, "emergency");
  assert.equal(e.outcome, "seek-care-now");
  assert.deepEqual(e.flagsFired, ["chest pain"]);
});

test("pidgin lexicon works — the patient speaks pcm, not textbook en", () => {
  const vt = new VoiceTriage();
  const e = vt.intake(note({ lang: "pcm",
    transcriptText: "e no dey breathe well since night" }), { patientRef: "p3" });
  assert.equal(e.priority, "emergency");
});

test("routine transcripts book visits, no flags", () => {
  const vt = new VoiceTriage();
  const e = vt.intake(note({ transcriptText: "I need my routine drug refill" }),
                      { patientRef: "p4" });
  assert.equal(e.priority, "routine");
  assert.equal(e.outcome, "book-visit");
});

test("duty board: emergencies first, unscored next, deterministic", () => {
  const vt = new VoiceTriage();
  vt.intake(note({ transcriptText: "routine refill" }), { patientRef: "p-r" });
  vt.intake(note(), { patientRef: "p-u" });
  vt.intake(note({ transcriptText: "severe bleeding" }), { patientRef: "p-e" });
  const board = vt.dutyBoard();
  assert.deepEqual(board.map(b => b.patientRef), ["p-e", "p-u", "p-r"]);
  assert.equal(board[0].mxc, "mxc://hs/abc");   // the audio rides along
});

test("transcript text never lands on the duty board — chars counted, content stays", () => {
  const vt = new VoiceTriage();
  vt.intake(note({ transcriptText: "private detail here" }), { patientRef: "p5" });
  const e = vt.queue[0];
  assert.equal(e.transcriptText, undefined);
  assert.equal(typeof e.transcriptChars, "number");
});
