// pushlane.test.mjs — push lanes: four-eyes registry, token TTL,
// honest states, loud refusals, dead-token reaping.
import { test } from "node:test";
import assert from "node:assert/strict";

import { PushRegistry, DeviceRegistry, PushLane,
         PUSHLANE_VERSION } from "../packages/pushlane/pushlane.js";

function mkStack(over = {}) {
  const registry = new PushRegistry();
  registry.proposeLane("clinic-ntfy", { kind: "ntfy",
    endpoint: "https://ntfy.clinic.example" }, { by: "infra-a" });
  registry.ratifyLane("clinic-ntfy", { by: "infra-b" });
  const devices = new DeviceRegistry(over.clock ? { now: over.clock } : {});
  const transport = over.transport || (async () => ({ ok: true, text: async () => "" }));
  const lane = new PushLane({ registry, devices, transport });
  return { registry, devices, lane };
}

test("version stamp", () => assert.equal(PUSHLANE_VERSION, "pushlane@1.0.0"));

test("lane registry: four-eyes, https-only, kinds closed", () => {
  const reg = new PushRegistry();
  assert.throws(() => reg.proposeLane("x", { kind: "pigeon",
    endpoint: "https://x" }, { by: "a" }), /registry kinds only/);
  assert.throws(() => reg.proposeLane("x", { kind: "ntfy",
    endpoint: "http://insecure" }, { by: "a" }), /https or they do not travel/);
  reg.proposeLane("x", { kind: "fcm", endpoint: "https://fcm.example" }, { by: "a" });
  assert.throws(() => reg.lane("x"), /proposed, not ratified/);
  assert.throws(() => reg.ratifyLane("x", { by: "a" }), /never ratifies/);
  reg.ratifyLane("x", { by: "b" });
  assert.equal(reg.lane("x").kind, "fcm");
});

test("no transport refuses loudly — no silent mock", async () => {
  const { devices } = mkStack();
  const lane = new PushLane({ registry: new PushRegistry(), devices });
  await assert.rejects(() => lane.nudge("d1", "ref-1"), /refusing loudly/);
});

test("token expiry refuses; sweep states the evicted", () => {
  let t = 1_000_000;
  const { devices } = mkStack({ clock: () => t });
  devices.register("d1", "clinic-ntfy", "tok-1");
  t += 91 * 24 * 3600 * 1000;
  assert.throws(() => devices.lookup("d1"), /expired/);
  assert.deepEqual(devices.sweep(), ["d1"]);
  assert.throws(() => devices.lookup("d1"), /not registered/);
});

test("nudge sends opaque ref, reports sent — never claims delivered", async () => {
  const seen = [];
  const { lane, devices } = mkStack({
    transport: async (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, text: async () => "" };
    } });
  devices.register("d1", "clinic-ntfy", "room-topic-9");
  const rec = await lane.nudge("d1", "evt-abc123", { title: "New message" });
  assert.equal(rec.status, "sent");
  assert.equal(seen[0].url, "https://ntfy.clinic.example/room-topic-9");
  assert.equal(seen[0].body.message, "evt-abc123");
  // push carries a nudge and a ref — never clinical content
  assert.ok(!JSON.stringify(seen[0].body).match(/diagnos|malaria|patient/i));
});

test("dead token (410) is reaped and stated", async () => {
  const { lane, devices } = mkStack({
    transport: async () => ({ ok: false, status: 410, text: async () => "gone" }) });
  devices.register("d1", "clinic-ntfy", "tok-dead");
  await assert.rejects(() => lane.nudge("d1", "ref-1"), /gone/);
  assert.throws(() => devices.lookup("d1"), /not registered/);
});

test("unratified lane blocks the send, stated", async () => {
  const registry = new PushRegistry();
  registry.proposeLane("shadow", { kind: "ntfy",
    endpoint: "https://x.example" }, { by: "a" });   // never ratified
  const devices = new DeviceRegistry();
  devices.register("d1", "shadow", "tok");
  const lane = new PushLane({ registry, devices,
    transport: async () => ({ ok: true, text: async () => "" }) });
  await assert.rejects(() => lane.nudge("d1", "ref-1"), /proposed, not ratified/);
});
