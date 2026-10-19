// media.js — rich content for matrix-lite: mxc:// resolution, offline-first
// media cache (IndexedDB blobs), and typed senders. The patient experience:
// a photo from the clinic opens even in airplane mode once seen before.

export function mxcToUrl(homeserver, mxc) {
  // mxc://server/mediaId → download endpoint on OUR homeserver
  const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc || "");
  if (!m) return null;
  const hs = homeserver.replace(/\/$/, "");
  return `${hs}/_matrix/media/v3/download/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`;
}

export function mxcThumbnailUrl(homeserver, mxc, width = 320, height = 240) {
  const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc || "");
  if (!m) return null;
  const hs = homeserver.replace(/\/$/, "");
  return `${hs}/_matrix/media/v3/thumbnail/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}` +
    `?width=${width}&height=${height}&method=scale`;
}

// downloadCached: cache-first. On a flaky link the blob is fetched ONCE and
// served from IndexedDB forever after. The store contract gains:
//   mediaGet(mxc) -> { blob, mime } | undefined
//   mediaPut(mxc, blob, mime)
export async function downloadCached({ homeserver, token, store, fetchImpl }, mxc) {
  const hit = await store.mediaGet(mxc);
  if (hit) return hit;
  const url = mxcToUrl(homeserver, mxc);
  if (!url) throw new Error(`bad mxc uri: ${mxc}`);
  const f = fetchImpl || globalThis.fetch;
  const res = await f(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`media ${mxc}: HTTP ${res.status}`);
  const blob = await res.blob();
  const mime = res.headers.get("Content-Type") || "application/octet-stream";
  await store.mediaPut(mxc, blob, mime);
  return { blob, mime };
}

// --- typed senders ----------------------------------------------------------
// Each returns the content object; the caller hands it to client.sendContent.
// Keeping them pure (no I/O) means the artefact grammar is unit-testable.

export const content = {
  text: (body) => ({ msgtype: "m.text", body }),

  image: (mxc, caption, info = {}) => ({
    msgtype: "m.image", body: caption || "image", url: mxc, info,
  }),

  audio: (mxc, caption, info = {}) => ({
    msgtype: "m.audio", body: caption || "audio", url: mxc, info,
  }),

  video: (mxc, caption, info = {}) => ({
    msgtype: "m.video", body: caption || "video", url: mxc, info,
  }),

  file: (mxc, filename, info = {}) => ({
    msgtype: "m.file", body: filename || "file", url: mxc, filename, info,
  }),

  // m.location — geo_uri "geo:lat,lon;u=uncertainty"
  location: (lat, lon, label, uncertainty) => ({
    msgtype: "m.location",
    body: label || `geo:${lat},${lon}`,
    geo_uri: `geo:${lat},${lon}${uncertainty ? `;u=${uncertainty}` : ""}`,
    "org.matrix.msc3488.location": { uri: `geo:${lat},${lon}`, description: label },
  }),

  // Health artifacts — structured cards the clinic sends: an appointment,
  // a prescription, a referral with a facility pin. Custom event content,
  // namespaced, gracefully rendered as text by any plain Matrix client.
  appointment: ({ title, facility, when, lat, lon, ref }) => ({
    msgtype: "ng.openhealth.artifact",
    artifact: "appointment",
    body: `${title} — ${facility}, ${when}${ref ? ` (${ref})` : ""}`,
    "ng.openhealth": { kind: "appointment", title, facility, when, lat, lon, ref },
  }),

  prescription: ({ title, items, ref }) => ({
    msgtype: "ng.openhealth.artifact",
    artifact: "prescription",
    body: `${title}: ${items.join(", ")}${ref ? ` (${ref})` : ""}`,
    "ng.openhealth": { kind: "prescription", title, items, ref },
  }),

  facility_pin: ({ name, lat, lon, phone, hours }) => ({
    msgtype: "ng.openhealth.artifact",
    artifact: "facility_pin",
    body: `${name}${hours ? ` — ${hours}` : ""}`,
    "ng.openhealth": { kind: "facility_pin", name, lat, lon, phone, hours },
  }),
};

// parseGeo: "geo:6.5244,3.3792;u=10" → { lat, lon, u }
export function parseGeo(uri) {
  const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:;u=(\d+(?:\.\d+)?))?/.exec(uri || "");
  if (!m) return null;
  return { lat: +m[1], lon: +m[2], u: m[3] ? +m[3] : undefined };
}

// classify: what renderer should handle this event's content?
export function classify(c) {
  if (!c) return "unknown";
  switch (c.msgtype) {
    case "m.text": return "text";
    case "m.image": return "image";
    case "m.audio": return "audio";
    case "m.video": return "video";
    case "m.file": return "file";
    case "m.location": return "location";
    case "ng.openhealth.artifact": return `artifact:${c.artifact || "generic"}`;
    default: return "unknown";
  }
}
