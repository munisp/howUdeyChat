/* domainpack.js — the general seam contract for any domain.
 *
 * howUdeyChat's health build proved the pattern: structured NDJSON
 * lines crossing between a domain system (contact graph, pharmacy,
 * claims) and the chat — worklists IN, field reports OUT, every line
 * well-formed or loudly rejected. This module generalizes that pattern
 * so the same client serves agriculture, cooperatives, education,
 * logistics — any domain — without forking the app.
 *
 * A domain pack declares:
 *   domain, version — every line carries both; unversioned seams refuse
 *   inbound:  { kind: { required: [...], render(hint) } }  — lines the
 *             domain system sends to the client (worklists, advisories)
 *   outbound: { kind: { required: [...] } } — lines the client emits
 *             (field reports, payments, attendance)
 *
 * Doctrine carried from the health build:
 * - FAIL-CLOSED: unknown kind, missing version, or missing required
 *   field = rejected, counted, never silently dropped or defaulted.
 * - ABSENCE IS NOT A VALUE: a field the event doesn't have is not
 *   emitted as a guess (the outbreak bridge's symptomatic rule).
 * - PACKS ARE DATA, THE ENGINE IS CODE: a domain author ships a pack
 *   object; this module enforces the contract.
 */

export function validatePack(pack) {
  if (!pack || typeof pack !== "object") throw new Error("pack must be an object");
  if (!pack.domain) throw new Error("pack.domain required");
  if (!pack.version) throw new Error("pack.version required — unversioned seams refuse");
  for (const dir of ["inbound", "outbound"]) {
    const spec = pack[dir] || {};
    for (const [kind, kspec] of Object.entries(spec)) {
      if (!Array.isArray(kspec.required) || kspec.required.length === 0) {
        throw new Error(`${dir}.${kind}: required field list needed`);
      }
    }
  }
  return true;
}

export class PackRegistry {
  constructor() { this.packs = new Map(); }

  register(pack) {
    validatePack(pack);
    const key = `${pack.domain}@${pack.version}`;
    if (this.packs.has(key)) throw new Error(`duplicate pack: ${key}`);
    this.packs.set(key, pack);
    return key;
  }

  get(domain, version = null) {
    if (version) {
      const p = this.packs.get(`${domain}@${version}`);
      if (!p) throw new Error(`unknown pack: ${domain}@${version}`);
      return p;
    }
    const matches = [...this.packs.values()].filter(p => p.domain === domain);
    if (!matches.length) throw new Error(`unknown domain: ${domain}`);
    return matches[matches.length - 1]; // latest registered wins
  }
}

/* INBOUND: parse and validate a worklist/advisory line from the domain
 * system. Returns { pack, kind, payload, render } or throws with the
 * reason — a bad line never renders. */
export function readInbound(pack, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { throw new Error("not JSON"); }
  const spec = (pack.inbound || {})[msg.kind];
  if (!spec) throw new Error(`unknown inbound kind: ${msg.kind}`);
  if (msg.pack_version !== pack.version) {
    throw new Error(`version mismatch: line says ${msg.pack_version}, pack is ${pack.version}`);
  }
  const missing = spec.required.filter(f => !(f in msg));
  if (missing.length) throw new Error(`missing fields: ${missing.join(",")}`);
  return { kind: msg.kind, payload: msg, renderHint: spec.render || "list" };
}

/* OUTBOUND: build one seam line from a client event, or null when the
 * event lacks a required field. Never guesses a value. */
export function toSeamLine(pack, kind, ev) {
  const spec = (pack.outbound || {})[kind];
  if (!spec) throw new Error(`unknown outbound kind: ${kind}`);
  if (!ev) return null;
  for (const f of spec.required) {
    if (!(f in ev) || ev[f] == null) return null; // absence is not a value
  }
  const payload = { kind, pack_version: pack.version };
  for (const f of spec.required) payload[f] = ev[f];
  for (const f of Object.keys(ev)) {
    if (!(f in payload) && f !== "kind") payload[f] = ev[f]; // extras pass through
  }
  return JSON.stringify(payload);
}

/* Batch outbound with honest rejection counting — same doctrine as the
 * outbreak bridge: rejected events are listed with reasons, never
 * dropped quietly. */
export function batchSeamLines(pack, kind, events) {
  const lines = [];
  const rejected = [];
  events.forEach((ev, i) => {
    let line = null;
    try { line = toSeamLine(pack, kind, ev); }
    catch (err) { rejected.push({ index: i, reason: err.message }); return; }
    if (line) lines.push(line);
    else rejected.push({ index: i, reason: "missing required field" });
  });
  return { lines, rejected };
}
