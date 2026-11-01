// voicenote.test.mjs — voice note message contract.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildVoiceNote, voiceNoteUxSpec, MAX_DURATION_S }
  from "../packages/voicenote/voicenote.js";

test("happy path: well-formed voice note", () => {
  const m = buildVoiceNote({ mxc: "mxc://relay/audio1", durationS: 42,
                             lang: "pcm" });
  assert.equal(m.msgtype, "m.audio");
  assert.equal(m.info["org.howudey.lang"], "pcm");
  assert.equal(m.info.duration, 42000);
  assert.equal(m.info["org.howudey.transcript"], "none");
});

test("bounds: duration over cap refuses with the limit named", () => {
  assert.throws(
    () => buildVoiceNote({ mxc: "mxc://r/a", durationS: MAX_DURATION_S + 1,
                           lang: "en" }),
    /limit/);
  assert.throws(
    () => buildVoiceNote({ mxc: "mxc://r/a", durationS: 0, lang: "en" }));
});

test("language required, no guessing", () => {
  assert.throws(
    () => buildVoiceNote({ mxc: "mxc://r/a", durationS: 5, lang: "fr" }));
  assert.throws(
    () => buildVoiceNote({ mxc: "mxc://r/a", durationS: 5, lang: null }));
});

test("transcript honesty: done needs text; text without done refuses", () => {
  assert.throws(() => buildVoiceNote({
    mxc: "mxc://r/a", durationS: 5, lang: "ha", transcript: "done" }));
  assert.throws(() => buildVoiceNote({
    mxc: "mxc://r/a", durationS: 5, lang: "ha",
    transcript: "pending", transcriptText: "sannu" }));
  const m = buildVoiceNote({ mxc: "mxc://r/a", durationS: 5, lang: "ha",
                             transcript: "done", transcriptText: "sannu" });
  assert.equal(m.info["org.howudey.transcript_text"], "sannu");
});

test("blob ref required", () => {
  assert.throws(() => buildVoiceNote({ mxc: "http://x/a.ogg",
                                       durationS: 5, lang: "en" }));
});

test("ux spec is low-literacy honest", () => {
  const ux = voiceNoteUxSpec();
  assert.equal(ux.review.playback_before_send, true);
  assert.equal(ux.digest.note.includes("never blocks"), true);
});
