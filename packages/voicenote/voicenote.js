/* voicenote.js — voice notes as a first-class message type.
 *
 * For low-literacy users a voice note IS the interface. The media
 * layer (matrix-lite/media.js) already handles mxc upload and the
 * offline cache; this module defines the message contract on top:
 * bounded duration, explicit language, honest transcription status.
 *
 * Doctrine:
 * - BOUNDED: MAX_DURATION_S keeps notes playable on duty; longer
 *   recordings refuse with the limit named.
 * - LANGUAGE DECLARED: a voice note without a language can't be
 *   digested or transcribed honestly — refused, not guessed.
 * - TRANSCRIPTION STATUS IS HONEST: transcript states are
 *   none | pending | done | failed. "failed" stays visible; a
 *   note is never presented as transcribed when it wasn't.
 * - OFFLINE-FIRST: the blob rides the media cache; a note recorded
 *   offline queues and syncs like everything else.
 */

export const MAX_DURATION_S = 600; // 10 minutes
export const LANGS = ["en", "pcm", "ha", "yo", "ig"];
export const TRANSCRIPT_STATES = ["none", "pending", "done", "failed"];

export function buildVoiceNote({ mxc, durationS, lang, waveform = null,
                                 transcript = "none", transcriptText = null }) {
  if (!mxc || !mxc.startsWith("mxc://")) {
    throw new Error("voice note requires an mxc:// blob reference");
  }
  if (typeof durationS !== "number" || !(durationS > 0)) {
    throw new Error("duration must be a positive number of seconds");
  }
  if (durationS > MAX_DURATION_S) {
    throw new Error(
      `voice note ${Math.round(durationS)}s exceeds the ` +
      `${MAX_DURATION_S}s limit — long recordings refuse`);
  }
  if (!LANGS.includes(lang)) {
    throw new Error(`language must be one of: ${LANGS.join(", ")}`);
  }
  if (!TRANSCRIPT_STATES.includes(transcript)) {
    throw new Error(`unknown transcript state: ${transcript}`);
  }
  if (transcript === "done" && !transcriptText) {
    throw new Error("transcript done requires the text — honest status");
  }
  if (transcript !== "done" && transcriptText) {
    throw new Error("transcript text with a non-done state is a lie");
  }
  return {
    msgtype: "m.audio",
    "org.howudey.voicenote": true,
    url: mxc,
    info: {
      duration: Math.round(durationS * 1000), // ms, matrix convention
      mimetype: "audio/ogg",
      "org.howudey.lang": lang,
      "org.howudey.waveform": waveform,
      "org.howudey.transcript": transcript,
      "org.howudey.transcript_text":
        transcript === "done" ? transcriptText : undefined,
    },
    body: `Voice note (${Math.round(durationS)}s, ${lang})`,
  };
}

/* UI affordance hints for low-literacy design: one big record target,
 * hold-to-talk, playback before send, cancel by slide. Returned as data
 * so every client renders the same honest flow. */
export function voiceNoteUxSpec() {
  return {
    record: { gesture: "hold", min_duration_s: 1,
              max_duration_s: MAX_DURATION_S,
              visual: "full-width target, countdown ring" },
    review: { playback_before_send: true, cancel_gesture: "slide-left" },
    playback: { speeds: [1, 1.5, 2], waveform_scrub: true },
    digest: { reads_transcript_when_done: true,
              plays_audio_otherwise: true,
              note: "a failed transcript never blocks playback" },
  };
}
