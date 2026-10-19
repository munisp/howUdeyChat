// preview.js — drives the REAL components (renderEvent, map.draw, i18n)
// with seeded data, for UI screenshots. ?screen=login|rooms|thread|thread-ha|offline
import { renderEvent } from "./render.js";
import { LANGS, setLang, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const screen = params.get("screen") || "thread";
if (screen === "thread-ha") setLang("ha");

// language picker
const sel = $("lang");
for (const [code, name] of Object.entries(LANGS)) {
  const o = document.createElement("option");
  o.value = code; o.textContent = name; sel.appendChild(o);
}
sel.value = screen === "thread-ha" ? "ha" : "en";

document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
$("tagline").textContent = t("tagline");
$("room-hint").textContent = t("health_room_hint");

const status = $("status");
const setStatus = (s) => { status.className = `pill ${s}`; status.textContent = t(`status_${s}`); };

const ME = "@amina:hs.demo";
// minimal client/store doubles for media (blob: URLs served directly)
const blobURL = (txt, mime) => URL.createObjectURL(new Blob([txt], { type: mime }));
const mediaMap = new Map();
const ctx = {
  client: { hs: "", token: "", fetch: async () => ({ ok: true, blob: async () => mediaMap.get("blob"), headers: { get: () => "image/png" } }) },
  store: { mediaGet: async (mxc) => mediaMap.get(mxc), mediaPut: async () => {} },
};

// a tiny generated "x-ray" png-like placeholder as an inline SVG blob
const xraySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
  <rect width="300" height="200" fill="#101820"/>
  <ellipse cx="150" cy="100" rx="80" ry="70" fill="#2a3640"/>
  <ellipse cx="150" cy="100" rx="52" ry="48" fill="#3d4d5c"/>
  <ellipse cx="150" cy="100" rx="20" ry="22" fill="#0c1218"/>
  <text x="12" y="24" fill="#9fb3c8" font-family="monospace" font-size="13">KAWO PHC · CXR · L PA</text>
  <text x="12" y="190" fill="#9fb3c8" font-family="monospace" font-size="11">pt OH-KD-0001</text>
</svg>`;
mediaMap.set("mxc://hs.demo/xray1", { blob: new Blob([xraySvg], { type: "image/svg+xml" }), mime: "image/svg+xml" });
mediaMap.set("mxc://hs.demo/voice1", { blob: new Blob([new Uint8Array(3000)], { type: "audio/ogg" }), mime: "audio/ogg" });

const events = [
  { sender: "@clinic:hs.demo", origin_server_ts: Date.now() - 3600e3,
    content: { msgtype: "m.text", body: "Sannu Amina! Your results are ready. Here is your chest x-ray from Tuesday." } },
  { sender: "@clinic:hs.demo", origin_server_ts: Date.now() - 3590e3,
    content: { msgtype: "m.image", body: "Chest x-ray, 14 Oct", url: "mxc://hs.demo/xray1" } },
  { sender: "@clinic:hs.demo", origin_server_ts: Date.now() - 3580e3,
    content: { msgtype: "m.audio", body: "Doctor's explanation (Hausa)", url: "mxc://hs.demo/voice1" } },
  { sender: ME, origin_server_ts: Date.now() - 3000e3,
    content: { msgtype: "m.text", body: "Na the x-ray be this? E clear well well. Thank you dokita 🙏" } },
  { sender: "@clinic:hs.demo", origin_server_ts: Date.now() - 2400e3,
    content: { msgtype: "ng.openhealth.artifact", artifact: "appointment",
               body: "ANC visit — Kawo PHC, Tue 21 Oct, 08:00 (OH-KD-0001)",
               "ng.openhealth": { kind: "appointment", title: "ANC visit — ante-natal clinic",
                                  facility: "Kawo Primary Health Centre", when: "Tuesday 21 Oct, 08:00",
                                  lat: 10.5203, lon: 7.4401, ref: "OH-KD-0001" } } },
  { sender: ME, origin_server_ts: Date.now() - 1800e3,
    content: { msgtype: "m.location", body: "I dey come from farm side", geo_uri: "geo:10.4982,7.4125;u=20" } },
];

async function main() {
  if (screen === "login") {
    setStatus("syncing");
    $("view-login").hidden = false;
    return;
  }
  if (screen === "rooms") {
    setStatus("live");
    $("view-rooms").hidden = false;
    const ul = $("room-list");
    for (const [name, sub] of [
      ["Kawo Primary Health Centre", "ANC visit — Tue 21 Oct, 08:00"],
      ["Dr. Bala (care team)", "Doctor's explanation (voice note)"],
      ["NHIA coverage desk", "You are covered under NHIA Basic"],
    ]) {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${name}</strong><br><span style="color:var(--muted);font-size:14px">${sub}</span>`;
      ul.appendChild(li);
    }
    return;
  }
  // thread screens
  setStatus(screen === "offline" ? "offline" : "live");
  $("view-thread").hidden = false;
  const ul = $("thread");
  for (const ev of events) {
    const li = await renderEvent(ev, ctx);
    if (ev.sender === ME) li.classList.add("mine");
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = new Date(ev.origin_server_ts).toLocaleString();
    li.appendChild(meta);
    ul.appendChild(li);
  }
  if (screen === "offline") {
    const li = document.createElement("li");
    li.className = "mine pending";
    li.textContent = t("queued_offline");
    const meta = document.createElement("span");
    meta.className = "meta"; meta.textContent = "…";
    li.appendChild(meta);
    ul.appendChild(li);
  }
}
main();
