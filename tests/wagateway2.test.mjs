// wagateway2.test.mjs — v1.1.0: webhook idempotency, status monotonicity,
// template governance, media upload, messaging-tier backpressure.
import { test } from "node:test";
import assert from "node:assert/strict";

import { WAGateway, TemplateRegistry, MessagingTier,
         WAGATEWAY_VERSION } from "../packages/wagateway/wagateway.js";

const okFetch = async () => ({
  ok: true, json: async () => ({ messages: [{ id: "wamid-1" }] }),
  text: async () => "",
});

function mkGw(over = {}) {
  return new WAGateway({ token: "t", phoneId: "123", appSecret: "sekrit",
                         fetchImpl: okFetch, ...over });
}

async function signedBody(gw, obj) {
  const body = JSON.stringify(obj);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("sekrit"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return [body, "sha256=" + hex];
}

function statusPayload(wamid, status) {
  return { entry: [{ changes: [{ value: {
    statuses: [{ id: wamid, status, recipient_id: "2348031234567",
                 timestamp: "1730000000" }] } }] }] };
}

test("version stamp", () => assert.equal(WAGATEWAY_VERSION, "wagateway@1.1.0"));

test("webhook retries dedupe — Meta's retry is an ack, not a new fact", async () => {
  const gw = mkGw();
  await gw.sendTemplate("+2348031234567", "clinic_notice");
  const [body, sig] = await signedBody(gw, statusPayload("wamid-1", "delivered"));
  const first = await gw.ingestStatusWebhook(body, sig);
  assert.equal(first[0].deduped, undefined);
  const again = await gw.ingestStatusWebhook(body, sig);
  assert.equal(again[0].deduped, true);
  assert.equal(gw.statuses.length, 1);   // recorded once
});

test("status never walks backwards; anomalies recorded", async () => {
  const gw = mkGw();
  await gw.sendTemplate("+2348031234567", "clinic_notice");
  for (const st of ["delivered", "read", "sent"]) {
    const [body, sig] = await signedBody(gw, statusPayload("wamid-1", st));
    await gw.ingestStatusWebhook(body, sig);
  }
  assert.equal(gw.outbound[0].status, "read");   // read -> sent refused
  assert.equal(gw.anomalies.length, 1);
  assert.equal(gw.anomalies[0].to, "sent");
  assert.equal(gw.report().anomalies, 1);
});

test("failed is terminal and out of the ladder", async () => {
  const gw = mkGw();
  await gw.sendTemplate("+2348031234567", "clinic_notice");
  const [b1, s1] = await signedBody(gw, statusPayload("wamid-1", "failed"));
  await gw.ingestStatusWebhook(b1, s1);
  assert.equal(gw.outbound[0].status, "failed");
  const [b2, s2] = await signedBody(gw, statusPayload("wamid-1", "delivered"));
  await gw.ingestStatusWebhook(b2, s2);
  assert.equal(gw.outbound[0].status, "failed");
  assert.equal(gw.anomalies.length, 1);
});

test("template registry: four-eyes, variants, unratified refuses", async () => {
  const reg = new TemplateRegistry();
  assert.throws(() => reg.propose("x", {}, { by: "comms" }), /no language/);
  reg.propose("clinic_notice", { langs: { en: "Your visit is {{1}}",
                                          pcm: "Your visit na {{1}}" } },
              { by: "comms" });
  assert.throws(() => reg.approve("clinic_notice", { by: "comms" }),
    /never approves/);
  reg.markSubmitted("clinic_notice", { by: "comms" });
  reg.approve("clinic_notice", { by: "matron" });

  const gw = mkGw();
  gw.useTemplates(reg);
  const rec = await gw.sendTemplate("+2348031234567", "clinic_notice",
                                    { lang: "pcm" });
  assert.equal(rec.status, "sent");
  await assert.rejects(
    () => gw.sendTemplate("+2348031234567", "clinic_notice", { lang: "fr" }),
    /no fr variant/);

  // unapproved template refuses before Meta ever sees it
  const reg2 = new TemplateRegistry();
  reg2.propose("drafty", { langs: { en: "hi" } }, { by: "comms" });
  const gw2 = mkGw();
  gw2.useTemplates(reg2);
  await assert.rejects(
    () => gw2.sendTemplate("+2348031234567", "drafty"),
    /only approved templates send/);
});

test("media upload returns id or states the failure", async () => {
  const gw = mkGw({ fetchImpl: async () => ({
    ok: true, json: async () => ({ id: "media-7" }), text: async () => "" }) });
  assert.equal(await gw.uploadMedia(new Uint8Array([1, 2, 3]), "image/jpeg"), "media-7");
  await assert.rejects(() => gw.uploadMedia(new Uint8Array(0), "image/jpeg"),
    /empty media/);
  const gwNoId = mkGw({ fetchImpl: async () => ({
    ok: true, json: async () => ({}), text: async () => "" }) });
  await assert.rejects(() => gwNoId.uploadMedia(new Uint8Array([1]), "image/jpeg"),
    /no id/);
});

test("messaging tier: declared cap, cap named at refusal, window rolls", async () => {
  let t = 1_000_000;
  const tier = new MessagingTier("tier-1k", { now: () => t });
  assert.throws(() => new MessagingTier("tier-5"), /declared tiers/);
  const gw = mkGw();
  gw.useTier(tier);
  // simulate cap with a tiny custom tier via direct manipulation
  const small = new MessagingTier("tier-1k", { now: () => t });
  small.cap = 2;
  const gw2 = mkGw();
  gw2.useTier(small);
  await gw2.sendTemplate("+2348000000001", "a");
  await gw2.sendTemplate("+2348000000002", "a");
  await assert.rejects(() => gw2.sendTemplate("+2348000000003", "a"),
    /tier-1k cap reached/);
  assert.equal(small.headroom(), 0);
  t += 25 * 3600 * 1000;                  // window rolls
  assert.equal(small.headroom(), 2);
});

test("registries bind once — no silent ungoverning", () => {
  const gw = mkGw();
  const reg = new TemplateRegistry();
  gw.useTemplates(reg);
  assert.throws(() => gw.useTemplates(reg), /already bound/);
  gw.useTier(new MessagingTier("tier-10k"));
  assert.throws(() => gw.useTier(new MessagingTier("tier-10k")), /already bound/);
});
