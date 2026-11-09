// ussdwire.test.mjs — aggregator registry, callback parsing by config,
// resume tokens: signed, expiring, single-use.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AggregatorRegistry, ResumeTokenIssuer,
         USSDWIRE_VERSION } from "../packages/ussdwire/ussdwire.js";

test("version stamp", () => assert.equal(USSDWIRE_VERSION, "ussdwire@1.0.0"));

test("aggregator entries declare their field mapping", () => {
  const reg = new AggregatorRegistry();
  assert.throws(() => reg.register("at", { sessionId: "sessionId" }),
    /field mapping for msisdn/);
  reg.register("at", { sessionId: "sessionId", msisdn: "phoneNumber", text: "text" });
  const parsed = reg.parse("at", { sessionId: "AT-9", phoneNumber: "+234801",
                                   text: "1*14" });
  assert.deepEqual(parsed, { sessionId: "AT-9", msisdn: "+234801",
                             text: "1*14", input: "14" });
  // a different aggregator, a different shape — config, not code
  reg.register("mtn-direct", { sessionId: "sid", msisdn: "msisdn", text: "input",
                               resumeToken: "resume" });
  const p2 = reg.parse("mtn-direct", { sid: "M-1", msisdn: "+234802",
                                       input: "2", resume: "tok" });
  assert.equal(p2.resumeToken, "tok");
  assert.throws(() => reg.parse("unknown", {}), /no entry, no wire/);
  assert.throws(() => reg.parse("at", { sessionId: "x" }), /missing session id or msisdn/);
});

test("resume token round-trips the exact state", async () => {
  const iss = new ResumeTokenIssuer("lane-secret");
  const tok = await iss.mint("+234801", "buy_age");
  const back = await iss.redeem(tok);
  assert.equal(back.msisdn, "+234801");
  assert.equal(back.menuState, "buy_age");
});

test("forged and malformed tokens refuse", async () => {
  const iss = new ResumeTokenIssuer("lane-secret");
  const tok = await iss.mint("+234801", "menu");
  const [b64] = tok.split(".");
  const forged = b64 + "." + "0".repeat(64);
  await assert.rejects(() => iss.redeem(forged), /signature mismatch/);
  await assert.rejects(() => iss.redeem("garbage"), /malformed/);
  await assert.rejects(() => iss.redeem(""), /malformed/);
});

test("single-use: a redial cannot be replayed", async () => {
  const iss = new ResumeTokenIssuer("lane-secret");
  const tok = await iss.mint("+234801", "menu");
  await iss.redeem(tok);
  await assert.rejects(() => iss.redeem(tok), /single-use/);
});

test("expired tokens state starting over", async () => {
  let t = 1_000_000;
  const iss = new ResumeTokenIssuer("lane-secret", { now: () => t });
  const tok = await iss.mint("+234801", "menu");
  t += 11 * 60 * 1000;
  await assert.rejects(() => iss.redeem(tok), /expired.*start the menu over/);
});

test("unsigned state is a hijack — secret required", () => {
  assert.throws(() => new ResumeTokenIssuer(""), /unsigned state is a hijack/);
});
