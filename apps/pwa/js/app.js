// app.js — wires matrix-lite + IndexedDB store + i18n into the UI.
// The UI renders from the store, never from the network: a message you sent
// appears instantly (pending), and the outbox flushes when the link allows.
import { MatrixLite, login } from "./vendor/matrix-lite/client.js";
import { IdbStore } from "./vendor/matrix-lite/store-idb.js";
import { LANGS, lang, setLang, t } from "./i18n.js";
import { renderEvent } from "./render.js";

const $ = (id) => document.getElementById(id);
const views = { login: $("view-login"), rooms: $("view-rooms"), thread: $("view-thread") };
const store = new IdbStore();
let client = null;
let currentRoom = null;

// --- i18n ------------------------------------------------------------------
function paintStatic() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $("tagline").textContent = t("tagline");
  $("room-hint").textContent = t("health_room_hint");
  $("empty-thread").textContent = t("empty_thread");
}
function buildLangPicker() {
  const sel = $("lang");
  sel.innerHTML = "";
  for (const [code, name] of Object.entries(LANGS)) {
    const o = document.createElement("option");
    o.value = code; o.textContent = name;
    sel.appendChild(o);
  }
  sel.value = lang();
  sel.onchange = () => { setLang(sel.value); paintStatic(); };
}

// --- views -----------------------------------------------------------------
function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
}
function setStatus(state) {
  const el = $("status");
  el.className = `pill ${state}`;
  el.textContent = t(`status_${state}`) || state;
}
function toast(msg) {
  const el = $("toast");
  el.textContent = msg; el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3500);
}

async function paintRooms() {
  const ul = $("room-list");
  ul.innerHTML = "";
  for (const roomId of await store.listRooms()) {
    const li = document.createElement("li");
    li.textContent = roomId;
    li.onclick = () => openThread(roomId);
    ul.appendChild(li);
  }
}

async function openThread(roomId) {
  currentRoom = roomId;
  show("thread");
  await paintThread();
}

async function paintThread() {
  if (!currentRoom) return;
  const ul = $("thread");
  ul.innerHTML = "";
  const events = await store.roomEvents(currentRoom);
  const pending = (await store.outboxAll()).filter((m) => m.roomId === currentRoom);
  $("empty-thread").hidden = events.length + pending.length > 0;
  for (const ev of events) {
    const li = await renderEvent(ev, { client, store });
    if (ev.sender === client?.userId) li.classList.add("mine");
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = new Date(ev.origin_server_ts || Date.now()).toLocaleString();
    li.appendChild(meta);
    ul.appendChild(li);
  }
  for (const m of pending) addBubble(ul, m.body, true, "…", true);
  ul.lastElementChild?.scrollIntoView({ block: "end" });
}
function addBubble(ul, body, mine, meta, pending = false) {
  const li = document.createElement("li");
  li.className = (mine ? "mine" : "") + (pending ? " pending" : "");
  li.textContent = body;
  const s = document.createElement("span");
  s.className = "meta"; s.textContent = meta;
  li.appendChild(s);
  ul.appendChild(li);
}

// --- client lifecycle --------------------------------------------------------
async function startClient(cfg) {
  client = new MatrixLite({ ...cfg, store });
  client.onSyncState = (s) => setStatus(s);
  client.onEvent = async (roomId) => {
    await paintRooms();
    if (roomId === currentRoom) await paintThread();
  };
  client.onSent = async () => { await paintThread(); };
  client.start(); // runs forever with backoff; stop() on logout
  show("rooms");
  await paintRooms();
}

$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  $("login-error").hidden = true;
  const btn = e.target.querySelector("button");
  btn.disabled = true; btn.textContent = t("signing_in");
  try {
    const hs = $("f-hs").value.trim() || "https://matrix.clinic.ng";
    const sess = await login(hs, $("f-user").value.trim(), $("f-pass").value);
    localStorage.setItem("huc-session", JSON.stringify({
      homeserver: hs, accessToken: sess.access_token, userId: sess.user_id,
    }));
    await startClient({ homeserver: hs, accessToken: sess.access_token, userId: sess.user_id });
  } catch (err) {
    const el = $("login-error");
    el.textContent = String(err.message || err);
    el.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = t("sign_in");
  }
};

$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("c-text");
  const text = input.value.trim();
  if (!text || !client || !currentRoom) return;
  input.value = "";
  await client.send(currentRoom, text); // durable first, network second
  await paintThread();
  if ($("status").classList.contains("offline")) toast(t("queued_offline"));
};

$("back").onclick = async () => { currentRoom = null; show("rooms"); await paintRooms(); };

// --- boot --------------------------------------------------------------------
buildLangPicker();
paintStatic();
setStatus("syncing");
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
const saved = localStorage.getItem("huc-session");
if (saved) startClient(JSON.parse(saved)).catch(() => show("login"));
