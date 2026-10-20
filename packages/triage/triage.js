// triage.js — in-chat structured triage (innovation 3).
//
// A rule-based, multilingual triage flow that runs entirely on-device:
// no model, no network, no diagnosis theatre. It asks structured
// questions; red-flag answers escalate to the staff escalation queue
// (ADR-0011) immediately. Everything it concludes is one of three honest
// outcomes: routine self-care guidance, book-a-visit, or seek-care-NOW.
// It never pretends to be a doctor.

export const FLOWS = Object.freeze({
  fever: {
    start: "f_duration",
    steps: {
      f_duration: {
        q: { en: "How many days has the fever lasted?", pcm: "How many days the fever don last?" },
        options: [
          { id: "lt3", label: { en: "Less than 3 days", pcm: "E neva reach 3 days" }, next: "f_flags" },
          { id: "ge3", label: { en: "3 days or more", pcm: "3 days or pass am" }, outcome: "visit" },
        ],
      },
      f_flags: {
        q: { en: "Any of these: stiff neck, confusion, convulsion, difficulty breathing?", pcm: "Person get stiff neck, dey confuse, dey shake body, or breath no dey free?" },
        options: [
          { id: "yes", label: { en: "Yes", pcm: "Yes" }, outcome: "emergency" },
          { id: "no", label: { en: "No", pcm: "No" }, outcome: "routine" },
        ],
      },
    },
  },
  pregnancy: {
    start: "p_flags",
    steps: {
      p_flags: {
        q: { en: "Any of these: vaginal bleeding, severe headache with blurred vision, convulsion, reduced baby movement?", pcm: "Blood dey come, headache wey eye dey blur, body dey shake, or baby no dey move well?" },
        options: [
          { id: "yes", label: { en: "Yes", pcm: "Yes" }, outcome: "emergency" },
          { id: "no", label: { en: "No", pcm: "No" }, outcome: "routine" },
        ],
      },
    },
  },
});

export const OUTCOMES = Object.freeze({
  routine: { level: "info", guidance: { en: "Rest, fluids, and monitor. Return if symptoms worsen.", pcm: "Rest well, drink water, watch am. Come back if e worse." } },
  visit: { level: "warning", guidance: { en: "Book a clinic visit within 24 hours.", pcm: "Book clinic visit within 24 hours." } },
  emergency: { level: "critical", escalate: true, guidance: { en: "Go to the nearest facility NOW or call the clinic line. Do not wait.", pcm: "Go hospital NOW or call clinic line. No wait at all." } },
});

export class Triage {
  constructor(flowName, lang = "en") {
    const flow = FLOWS[flowName];
    if (!flow) throw new Error(`unknown flow: ${flowName}`);
    this.flow = flow; this.lang = lang; this.current = flow.start; this.path = [];
  }
  question() {
    const step = this.flow.steps[this.current];
    return { id: this.current, text: step.q[this.lang] || step.q.en,
      options: step.options.map((o) => ({ id: o.id, label: o.label[this.lang] || o.label.en })) };
  }
  answer(optionId) {
    const step = this.flow.steps[this.current];
    const opt = step.options.find((o) => o.id === optionId);
    if (!opt) throw new Error(`invalid option: ${optionId}`);
    this.path.push({ step: this.current, answer: optionId });
    if (opt.outcome) {
      const outcome = { name: opt.outcome, ...OUTCOMES[opt.outcome] };
      this.current = null;
      return { done: true, outcome, escalate: !!outcome.escalate, path: this.path };
    }
    this.current = opt.next;
    return { done: false, question: this.question() };
  }
}
