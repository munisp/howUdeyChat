// ladder.test.mjs — channel ladder: plans as data, stated escalation,
// visible costs, silence never success.
import { test } from "node:test";
import assert from "node:assert/strict";

import { CorridorRegistry, ChannelLadder,
         LADDER_VERSION } from "../packages/ladder/ladder.js";

function mkCorridors() {
  const c = new CorridorRegistry();
  c.register("ng-lagos", { currency: "NGN", lanes: [
    { id: "push", ackWindowMs: 5_000, costMinor: 0 },
    { id: "whatsapp", ackWindowMs: 60_000, costMinor: 350 },
    { id: "sms", ackWindowMs: 30_000, costMinor: 500 },
    { id: "ussd", ackWindowMs: 10_000, costMinor: 0 }] });
  return c;
}

test("version stamp", () => assert.equal(LADDER_VERSION, "ladder@1.0.0"));

test("plans are data: unknown corridor/lane refuses, loops refuse", () => {
  const c = new CorridorRegistry();
  assert.throws(() => c.register("x", { currency: "NGN", lanes: [] }), /no lanes/);
  assert.throws(() => c.register("x", { currency: "NGN",
    lanes: [{ id: "pigeon", ackWindowMs: 1, costMinor: 0 }] }), /registry lanes/);
  assert.throws(() => c.register("x", { currency: "NGN", lanes: [
    { id: "push", ackWindowMs: 1, costMinor: 0 },
    { id: "push", ackWindowMs: 1, costMinor: 0 }] }), /loop is not a ladder/);
  assert.throws(() => c.register("x", { lanes: [{ id: "push", ackWindowMs: 1, costMinor: 0 }] }),
    /currency required/);
  assert.throws(() => c.plan("nowhere"), /no plan, no send/);
});

test("first-lane delivery stops the walk and costs only that hop", async () => {
  const ladder = new ChannelLadder({ corridors: mkCorridors(), lanes: {
    push: { send: async () => ({ status: "delivered" }) },
  } });
  const rec = await ladder.send("ng-lagos", "+234801", { ref: "alert-1" });
  assert.equal(rec.outcome.state, "delivered");
  assert.equal(rec.outcome.via, "push");
  assert.equal(rec.attempts.length, 1);
  const stmt = await ladder.statement("ng-lagos");
  assert.equal(stmt.totalMinor, 0);
  assert.equal(stmt.hops, 1);
  assert.ok(stmt.sha256);
});

test("unconfirmed escalates with stated reason; cost ledger visible", async () => {
  // push: no pollStatus -> waits out window, escalates
  // whatsapp: throws -> failed
  // sms: sent then delivers on poll -> stops there
  const ladder = new ChannelLadder({
    corridors: mkCorridors(),
    now: (() => { let t = 0; return () => (t += 10_000); })(),
    sleep: async () => {},
    lanes: {
      push: { send: async () => ({ status: "sent" }) },
      whatsapp: { send: async () => { throw new Error("tier cap reached"); } },
      sms: { send: async () => ({ status: "sent", id: "sms-1" }),
             pollStatus: async () => ({ status: "delivered" }) },
    } });
  const rec = await ladder.send("ng-lagos", "+234801", { ref: "alert-2" });
  assert.equal(rec.outcome.via, "sms");
  const reasons = rec.attempts.map(a => `${a.lane}:${a.outcome}`).join(",");
  assert.equal(reasons, "push:sent,push:unconfirmed,whatsapp:failed,sms:sent,sms:delivered");
  assert.match(rec.attempts[1].reason, /no delivery ack.*escalating, stated/);
  assert.match(rec.attempts[2].reason, /tier cap reached/);
  const stmt = await ladder.statement("ng-lagos");
  assert.equal(stmt.totalMinor, 850);   // whatsapp 350 + sms 500; push free
  assert.equal(stmt.hops, 3);
  assert.equal(stmt.currency, "NGN");
});

test("unconfigured lane is skipped and stated, not fatal", async () => {
  const ladder = new ChannelLadder({
    corridors: mkCorridors(), sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 10_000); })(),
    lanes: { sms: { send: async () => ({ status: "delivered" }) } } });
  const rec = await ladder.send("ng-lagos", "+234801", { ref: "alert-3" });
  assert.equal(rec.attempts[0].outcome, "unavailable");
  assert.equal(rec.outcome.via, "sms");
});

test("all lanes failing = undelivered, stated, never retried forever", async () => {
  const ladder = new ChannelLadder({
    corridors: mkCorridors(), sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 10_000); })(),
    lanes: {} });   // nothing configured at all
  const rec = await ladder.send("ng-lagos", "+234801", { ref: "alert-4" });
  assert.equal(rec.outcome.state, "undelivered");
  assert.match(rec.outcome.note, /stated, not retried forever/);
  assert.equal(rec.attempts.length, 4);
});

test("the attempt chain rides on the record — escalation is auditable", async () => {
  const ladder = new ChannelLadder({
    corridors: mkCorridors(), sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 10_000); })(),
    lanes: { whatsapp: { send: async () => ({ status: "sent" }),
                         pollStatus: async () => ({ status: "sent" }) } } });
  const rec = await ladder.send("ng-lagos", "+234801", { ref: "alert-5" });
  assert.equal(rec.outcome.state, "undelivered");
  const wa = rec.attempts.filter(a => a.lane === "whatsapp");
  assert.deepEqual(wa.map(a => a.outcome), ["sent", "unconfirmed"]);
});

test("statement for an untouched corridor states nothing spent", async () => {
  const ladder = new ChannelLadder({ corridors: mkCorridors() });
  await assert.rejects(() => ladder.statement("ng-lagos"), /nothing spent, stated/);
});
