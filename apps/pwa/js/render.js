// render.js — turns one Matrix event into a DOM node. Dispatch on msgtype:
// text / image / audio / video / file / location / health artifacts.
// Media is resolved through the offline blob cache; maps draw on canvas
// with zero tiles.
import { classify, parseGeo, mxcToUrl, downloadCached } from "../vendor/matrix-lite/media.js";
import { draw } from "./map.js";
import { t } from "./i18n.js";

export async function renderEvent(ev, ctx) {
  // ctx: { client, store } — media needs homeserver+token+store
  const c = ev.content || {};
  const kind = classify(c);
  const li = document.createElement("li");

  switch (kind) {
    case "text":
      li.textContent = c.body || "";
      return li;

    case "image": {
      const img = document.createElement("img");
      img.alt = c.body || "image";
      img.className = "media-img";
      li.appendChild(img);
      hydrateMedia(img, c.url, ctx); // async, cache-first
      if (c.body) li.appendChild(caption(c.body));
      return li;
    }
    case "audio": {
      const a = document.createElement("audio");
      a.controls = true; a.preload = "metadata";
      li.appendChild(a);
      hydrateMedia(a, c.url, ctx);
      if (c.body && c.body !== "audio") li.appendChild(caption(c.body));
      return li;
    }
    case "video": {
      const v = document.createElement("video");
      v.controls = true; v.preload = "metadata"; v.className = "media-video";
      li.appendChild(v);
      hydrateMedia(v, c.url, ctx);
      if (c.body && c.body !== "video") li.appendChild(caption(c.body));
      return li;
    }
    case "file": {
      const a = document.createElement("a");
      a.textContent = `📄 ${c.filename || c.body || "file"}`;
      a.download = c.filename || "file";
      li.appendChild(a);
      hydrateMedia(a, c.url, ctx, true);
      return li;
    }
    case "location": {
      const geo = parseGeo(c.geo_uri);
      if (!geo) { li.textContent = c.body || ""; return li; }
      li.appendChild(mapNode([{ ...geo, label: c.body, kind: "clinic" }]));
      return li;
    }
    case "artifact:appointment":
    case "artifact:facility_pin": {
      const d = c["ng.openhealth"] || {};
      li.appendChild(artifactCard(c.artifact, d, c.body));
      if (typeof d.lat === "number" && typeof d.lon === "number") {
        li.appendChild(mapNode([{ lat: d.lat, lon: d.lon, label: d.facility || d.name, kind: "clinic" }]));
      }
      return li;
    }
    case "artifact:prescription": {
      const d = c["ng.openhealth"] || {};
      li.appendChild(artifactCard("prescription", d, c.body));
      return li;
    }
    default:
      li.textContent = c.body || `[${kind}]`;
      return li;
  }
}

function caption(text) {
  const s = document.createElement("span");
  s.className = "media-caption";
  s.textContent = text;
  return s;
}

function mapNode(pins) {
  const cv = document.createElement("canvas");
  cv.className = "map";
  // draw after attach so clientWidth is real
  requestAnimationFrame(() => draw(cv, { pins }));
  return cv;
}

function artifactCard(kind, d, fallback) {
  const div = document.createElement("div");
  div.className = "artifact";
  const title = document.createElement("strong");
  title.textContent = d.title || d.name || fallback || kind;
  div.appendChild(title);
  const lines = [];
  if (d.facility) lines.push(d.facility);
  if (d.when) lines.push(d.when);
  if (d.hours) lines.push(d.hours);
  if (d.phone) lines.push(`☎ ${d.phone}`);
  if (d.items) lines.push(...d.items.map((i) => `• ${i}`));
  for (const l of lines) {
    const p = document.createElement("span");
    p.textContent = l;
    div.appendChild(p);
  }
  return div;
}

// hydrateMedia: cache-first blob → objectURL. On a dead link with no cache
// hit, the node keeps a retry affordance instead of a broken icon.
async function hydrateMedia(node, mxc, ctx, asLink = false) {
  try {
    const { blob } = await downloadCached({
      homeserver: ctx.client.hs, token: ctx.client.token,
      store: ctx.store, fetchImpl: ctx.client.fetch,
    }, mxc);
    const url = URL.createObjectURL(blob);
    if (asLink) node.href = url; else node.src = url;
  } catch {
    if (asLink) node.removeAttribute("href");
    node.classList.add("media-pending");
    node.title = t("retry");
    node.onclick = () => { node.classList.remove("media-pending"); hydrateMedia(node, mxc, ctx, asLink); };
  }
}
