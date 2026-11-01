// wagateway.test.mjs — WhatsApp gateway contract.
import { test } from "node:test";
import assert from "node:assert/strict";

import { WAGateway } from "../packages/wagateway/wagateway.js";

const okFetch = async () => ({
  ok: true, json: async () => ({ messages: [{ id: "wamid-1" }] }),
  text: async () => "",
});

function mkGw(over = {}) {
  return new WAGateway({ token: "t", phoneId: "123", appSecret: "sekrit",
                         fetchImpl: okFetch, ...over });
}

test("unconfigured gateway refuses loudly", async () => {
  const gw = new WAGateway({});
  await assert.rejects(() => gw.sendTemplate("+2348031234567", "hello"),
    /refusing loudly/);
});

test("template send happy path; non-E164 refused", async () => {
  const gw = mkGw();
  const rec = await gw.sendTemplate("+2348031234567", "clinic_notice",
                                    { params: ["Tue 9am"] });
  assert.equal(rec.status, "sent");
  assert.equal(rec.wamid, "wamid-1");
  await assert.rejects(() => gw.sendTemplate("0803", "x"), /E\.164/);
});

test("business-initiated free-form refused (Meta template policy)", async () => {
  const gw = mkGw();
  await assert.rejects(() => gw.sendTemplate("+2348031234567", null),
    /templates/);
});

test("API failure raises, never silent", async () => {
  const gw = mkGw({ fetchImpl: async () => ({
    ok: false, status: 401, text: async () => "bad token" }) });
  await assert.rejects(() => gw.sendTemplate("+2348031234567", "x"),
    /401/);
});

test("status webhook: signature verified, state ladder honest", async () => {
  const gw = mkGw();
  await gw.sendTemplate("+2348031234567", "clinic_notice");
  const body = JSON.stringify({ entry: [{ changes: [{ value: {
    statuses: [{ id: "wamid-1", status: "delivered",
                 recipient_id: "2348031234567", timestamp: "1730000000" }] } }] }] });
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("sekrit"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const statuses = await gw.ingestStatusWebhook(body, "sha256=" + hex);
  assert.equal(statuses[0].status, "delivered");
  assert.equal(gw.outbound[0].status, "delivered");
  assert.equal(gw.report().read, 0); // delivered ≠ read
});

test("bad signature quarantined, not processed", async () => {
  const gw = mkGw();
  await assert.rejects(
    () => gw.ingestStatusWebhook("{}", "sha256=deadbeef"),
    /quarantined/);
  assert.equal(gw.quarantine.length, 1);
  assert.equal(gw.statuses.length, 0);
});

test("webhook without app secret refuses", async () => {
  const gw = mkGw({ appSecret: null });
  await assert.rejects(() => gw.ingestStatusWebhook("{}", "x"),
    /app secret/);
});
