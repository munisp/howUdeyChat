// rich-content.test.mjs — media resolution, offline cache, artifacts, map math.
// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mxcToUrl, mxcThumbnailUrl, downloadCached, content, parseGeo, classify } from "../packages/matrix-lite/media.js";
import { MemoryStore } from "../packages/matrix-lite/store-memory.js";
import { MatrixLite } from "../packages/matrix-lite/client.js";
import { project, fitBounds, haversineKm } from "../apps/pwa/js/map.js";

test("mxc:// resolves to download and thumbnail endpoints", () => {
  assert.equal(mxcToUrl("https://hs.ng/", "mxc://hs.ng/abc123"),
    "https://hs.ng/_matrix/media/v3/download/hs.ng/abc123");
  assert.match(mxcThumbnailUrl("https://hs.ng", "mxc://hs.ng/abc", 320, 240),
    /\/_matrix\/media\/v3\/thumbnail\/hs\.ng\/abc\?width=320&height=240/);
  assert.equal(mxcToUrl("https://hs.ng", "not-an-mxc"), null);
});

test("downloadCached: first call fetches, second call never touches network", async () => {
  const store = new MemoryStore();
  let fetches = 0;
  const f = async () => {
    fetches++;
    return { ok: true, blob: async () => new Blob(["PNG..."]), headers: new Map([["Content-Type", "image/png"]]), };
  };
  // headers.get shim
  const f2 = async () => {
    fetches++;
    return { ok: true, blob: async () => new Blob(["PNG..."]), headers: { get: () => "image/png" } };
  };
  const ctx = { homeserver: "https://hs.ng", token: "t", store, fetchImpl: f2 };
  const a = await downloadCached(ctx, "mxc://hs.ng/x");
  assert.equal(a.mime, "image/png");
  const b = await downloadCached(ctx, "mxc://hs.ng/x");
  assert.equal(b.mime, "image/png");
  assert.equal(fetches, 1, "cache hit must not re-fetch");
});

test("content builders produce spec-shaped payloads", () => {
  assert.deepEqual(content.text("Sannu"), { msgtype: "m.text", body: "Sannu" });
  assert.equal(content.image("mxc://s/i", "x-ray").msgtype, "m.image");
  const loc = content.location(6.5244, 3.3792, "Kawo PHC", 15);
  assert.equal(loc.geo_uri, "geo:6.5244,3.3792;u=15");
  const appt = content.appointment({ title: "ANC visit", facility: "Kawo PHC", when: "Tue 08:00", lat: 10.5, lon: 7.4, ref: "OH-1" });
  assert.equal(appt.msgtype, "ng.openhealth.artifact");
  assert.equal(appt["ng.openhealth"].kind, "appointment");
  assert.match(appt.body, /ANC visit/); // plain clients still show something useful
});

test("parseGeo + classify", () => {
  assert.deepEqual(parseGeo("geo:6.5244,3.3792;u=10"), { lat: 6.5244, lon: 3.3792, u: 10 });
  assert.equal(parseGeo("geo:bad"), null);
  assert.equal(classify({ msgtype: "m.audio" }), "audio");
  assert.equal(classify({ msgtype: "m.location" }), "location");
  assert.equal(classify({ msgtype: "ng.openhealth.artifact", artifact: "appointment" }), "artifact:appointment");
  assert.equal(classify({ msgtype: "m.weird" }), "unknown");
});

test("rich content rides the same durable outbox as text", async () => {
  const store = new MemoryStore();
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ event_id: "$e" }) };
  };
  const c = new MatrixLite({ homeserver: "https://hs.ng", accessToken: "t", userId: "@p:hs", store, fetchImpl: f });
  await c.sendContent("!r:hs", content.location(6.52, 3.37, "I am here"));
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.msgtype, "m.location");
  assert.equal(sent.geo_uri, "geo:6.52,3.37");
  assert.equal((await store.outboxAll()).length, 0);
});

test("map math: projection, bounds, distance", () => {
  const b = { minLat: 6.0, maxLat: 7.0, minLon: 3.0, maxLon: 4.0 };
  const p = project(6.5, 3.5, b, 100, 200);
  assert.deepEqual(p, { x: 50, y: 100 });
  const fitted = fitBounds([{ lat: 6.5, lon: 3.4 }, { lat: 6.6, lon: 3.5 }]);
  assert.ok(fitted.minLat < 6.5 && fitted.maxLat > 6.6);
  const lagos = { lat: 6.5244, lon: 3.3792 }, abuja = { lat: 9.0765, lon: 7.3986 };
  const d = haversineKm(lagos, abuja);
  assert.ok(d > 500 && d < 560, `Lagos–Abuja ≈ 536 km, got ${d.toFixed(0)}`);
});
