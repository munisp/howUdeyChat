// domainpack.test.mjs — the general seam contract, proven on two
// non-health domains.
import { test } from "node:test";
import assert from "node:assert/strict";

import { validatePack, PackRegistry, readInbound, toSeamLine,
         batchSeamLines } from "../packages/domainpack/domainpack.js";
import { AGRI_PACK_V1, COOP_PACK_V1 } from "../packages/domainpack/packs.js";

test("pack validation: version and required fields mandatory", () => {
  assert.throws(() => validatePack({ domain: "x" }), /version/);
  assert.throws(() => validatePack({ domain: "x", version: "1",
    outbound: { "r": {} } }), /required/);
  assert.equal(validatePack(AGRI_PACK_V1), true);
});

test("registry: keyed by domain@version, duplicates refuse", () => {
  const reg = new PackRegistry();
  reg.register(AGRI_PACK_V1);
  reg.register(COOP_PACK_V1);
  assert.throws(() => reg.register(AGRI_PACK_V1), /duplicate/);
  assert.equal(reg.get("cooperative").version, "coop-1.0.0-seed");
  assert.throws(() => reg.get("banking"), /unknown domain/);
});

test("inbound: valid worklist parses, version mismatch refuses", () => {
  const line = JSON.stringify({
    kind: "extension-worklist", pack_version: "agri-1.0.0-seed",
    officer: "ext-4", day: "2026-11-01", visits: ["farm-1", "farm-2"],
  });
  const r = readInbound(AGRI_PACK_V1, line);
  assert.equal(r.kind, "extension-worklist");
  assert.equal(r.renderHint, "worklist");

  const stale = JSON.stringify({
    kind: "extension-worklist", pack_version: "agri-0.9",
    officer: "ext", day: "d", visits: [] });
  assert.throws(() => readInbound(AGRI_PACK_V1, stale), /version mismatch/);
});

test("inbound: missing required field and unknown kind refuse", () => {
  const noVisits = JSON.stringify({
    kind: "extension-worklist", pack_version: "agri-1.0.0-seed",
    officer: "e", day: "d" });
  assert.throws(() => readInbound(AGRI_PACK_V1, noVisits), /missing fields: visits/);
  const alien = JSON.stringify({
    kind: "weather-alert", pack_version: "agri-1.0.0-seed" });
  assert.throws(() => readInbound(AGRI_PACK_V1, alien), /unknown inbound kind/);
  assert.throws(() => readInbound(AGRI_PACK_V1, "not json"), /not JSON/);
});

test("outbound: well-formed contribution line carries version", () => {
  const line = toSeamLine(COOP_PACK_V1, "contribution", {
    member: "m-22", day: "2026-11-01", amount: 5000, method: "transfer",
    note: "November dues" });
  const msg = JSON.parse(line);
  assert.equal(msg.kind, "contribution");
  assert.equal(msg.pack_version, "coop-1.0.0-seed");
  assert.equal(msg.amount, 5000);
  assert.equal(msg.note, "November dues"); // extras pass through
});

test("outbound: absence is not a value — missing amount refuses", () => {
  assert.equal(toSeamLine(COOP_PACK_V1, "contribution",
    { member: "m-22", day: "d", method: "cash" }), null);
  assert.equal(toSeamLine(COOP_PACK_V1, "contribution",
    { member: "m-22", day: "d", amount: 0, method: "cash" }) !== null, true);
  // 0 is a value (free-will zero? recorded); null is absence
  assert.equal(toSeamLine(COOP_PACK_V1, "contribution",
    { member: "m-22", day: "d", amount: null, method: "cash" }), null);
});

test("batch: rejections counted and listed, never dropped quietly", () => {
  const { lines, rejected } = batchSeamLines(AGRI_PACK_V1, "field-report", [
    { reporter: "f1", day: "d", crop: "maize", observation: "fall armyworm" },
    { reporter: "f2", day: "d", observation: "wilt" },        // no crop
    { reporter: "f3", day: "d", crop: "cassava", observation: "ok" },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].index, 1);
  assert.match(rejected[0].reason, /missing required field/);
});

test("cross-domain: coop pack refuses agri kinds", () => {
  assert.throws(() => toSeamLine(COOP_PACK_V1, "field-report", {}),
    /unknown outbound kind/);
});
