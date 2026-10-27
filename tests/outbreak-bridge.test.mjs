// outbreak-bridge.test.mjs — the chat side of the contact-tracing seam.
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderTracerDay, toCheckinLine, batchCheckinLines }
  from "../packages/outbreak/outbreak_bridge.js";

const WL = JSON.stringify({
  kind: "trace-worklist", day: "2026-10-23", tracer: "tracer-a",
  overdue: ["C-03"], due: ["C-01"], done: ["C-02"],
});

test("worklist renders and arms ladders for overdue contacts", () => {
  const day = renderTracerDay(WL);
  assert.deepEqual(day.overdue, ["C-03"]);
  assert.deepEqual(day.armLaddersFor, ["C-03"]);
  assert.deepEqual(day.due, ["C-01"]);
});

test("non-worklist lines refuse", () => {
  assert.throws(() => renderTracerDay(JSON.stringify({ kind: "nope" })));
});

test("kiosk-shaped events become graph check-in lines", () => {
  const line = toCheckinLine({
    patient_id: "C-01", day: "2026-10-23", symptomatic: false });
  const ev = JSON.parse(line);
  assert.equal(ev.kind, "trace-checkin");
  assert.equal(ev.contact, "C-01");
  assert.equal(ev.symptomatic, false);
});

test("missing symptom flag is refused, not defaulted", () => {
  // absence of a symptom declaration is not a healthy declaration
  assert.equal(toCheckinLine({ patient_id: "C-01", day: "2026-10-23" }), null);
  assert.equal(toCheckinLine(null), null);
  assert.equal(toCheckinLine({ day: "2026-10-23", symptomatic: true }), null);
});

test("batch conversion rejects honestly", () => {
  const out = batchCheckinLines([
    { patient_id: "C-01", day: "2026-10-23", symptomatic: false },
    { patient_id: "C-02", day: "2026-10-23" }, // no flag
    { patient_id: "C-03", day: "2026-10-23", symptomatic: true },
  ]);
  assert.equal(out.lines.length, 2);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].index, 1);
});

test("symptomatic conversion round-trips through the seam", () => {
  // the exact line a converted contact produces for the graph
  const line = toCheckinLine({
    patient_id: "C-02", day: "2026-10-22", symptomatic: true });
  assert.ok(JSON.parse(line).symptomatic);
});
