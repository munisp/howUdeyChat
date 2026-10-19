// apps/console/js/console.js — staff console: claim escalations, engage patients.
// Same matrix-lite core as the patient app; the queue comes from the admin service.
import { MatrixLite, login } from "../vendor/matrix-lite/client.js";
import { MemoryStore } from "../vendor/matrix-lite/store-memory.js";
import { CallManager } from "../vendor/matrix-lite/calls.js";

const $ = (id) => document.getElementById(id);
const state = {
  client: null, calls: null, admin: "", token: "",
  queue: [], sel: null, // selected escalation
};

// --- admin API ---------------------------------------------------------------
async function adminApi(method, path, body) {
  const res = await fetch(state.admin + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(method + " " + path + " -> " + res.status);
  return res.json();
}

async function pollQueue() {
  try {
    const { queue } = await adminApi("GET", "/v1/queue");
    state.queue = queue || [];
    renderQueue();
  } catch { /* admin down — keep last view */ }
  setTimeout(pollQueue, 3000);
}

function renderQueue() {
  const el = $("qlist");
  el.innerHTML = "";
  if (!state.queue.length) {
    el.innerHTML = '<div class="empty">No patients waiting.</div>';
    return;
  }
  for (const e of state.queue) {
    const d = document.createElement("div");
    d.className = "qitem" + (state.sel && state.sel.id === e.id ? " sel" : "");
    d.innerHTML = `<div class="patient">${esc(e.username)}</div>
      <div class="reason">${esc(e.reason || "—")}</div>
      <div class="status ${e.status}">${e.status}${e.claimed_by ? " · " + esc(e.claimed_by) : ""}</div>`;
    d.onclick = () => openEscalation(e);
    el.appendChild(d);
  }
}

// --- engagement ---------------------------------------------------------------
async function openEscalation(e) {
  // first claim wins; already-mine is fine
  try {
    if (e.status === "waiting") {
      await adminApi("POST", "/v1/queue/claim", { id: e.id, staff_username: state.staff });
      e.status = "claimed"; e.claimed_by = state.staff;
    } else if (e.claimed_by !== state.staff) {
      alert("Claimed by " + e.claimed_by);
      return;
    }
  } catch (err) { alert(err.message); return; }
  state.sel = e;
  $("threadtitle").textContent = e.username + (e.reason ? " — " + e.reason : "");
  $("composer").hidden = false;
  $("btn-call").disabled = $("btn-video").disabled = $("btn-resolve").disabled = false;
  renderQueue();
  renderThread();
}

async function renderThread() {
  const el = $("msgs");
  el.innerHTML = "";
  if (!state.sel) return;
  const events = await state.store.roomEvents(state.sel.room_id);
  for (const ev of events) {
    const d = document.createElement("div");
    const mine = ev.sender === state.client.userId;
    d.className = "msg" + (mine ? " mine" : "");
    const who = mine ? "You" : ev.sender;
    const body = ev.content?.body ?? "";
    if (ev.type === "m.room.message") {
      d.innerHTML = `<div class="who">${esc(who)}</div>${esc(body)}`;
    } else if (ev.type === "m.room.encrypted") {
      d.innerHTML = `<div class="who">${esc(who)}</div><span class="sys">🔒 encrypted (room key not on this device)</span>`;
    } else {
      d.innerHTML = `<div class="sys">${esc(ev.type)}</div>`;
    }
    el.appendChild(d);
  }
  el.scrollTop = el.scrollHeight;
}

$("composer").onsubmit = async (ev) => {
  ev.preventDefault();
  const text = $("text").value.trim();
  if (!text || !state.sel) return;
  $("text").value = "";
  await state.client.send(state.sel.room_id, text); // queue-first: never lost
};

$("btn-call").onclick = () => state.calls && state.calls.placeCall(state.sel.room_id, { video: false });
$("btn-video").onclick = () => state.calls && state.calls.placeCall(state.sel.room_id, { video: true });

$("btn-resolve").onclick = async () => {
  if (!state.sel) return;
  try {
    await adminApi("POST", "/v1/queue/resolve", { id: state.sel.id, staff_username: state.staff });
    state.sel = null;
    $("composer").hidden = true;
    $("threadtitle").textContent = "Select a patient";
    $("btn-call").disabled = $("btn-video").disabled = $("btn-resolve").disabled = true;
    $("msgs").innerHTML = '<div class="empty">Resolved. Waiting patients are on the left.</div>';
  } catch (err) { alert(err.message); }
};

// --- login ---------------------------------------------------------------------
$("loginform").onsubmit = async (ev) => {
  ev.preventDefault();
  $("loginerr").textContent = "";
  state.admin = $("admin").value.trim();
  state.token = $("token").value;
  try {
    const sess = await login($("hs").value.trim(), $("user").value.trim(), $("pass").value);
    const store = new MemoryStore();
    state.store = store;
    const client = new MatrixLite({ ...sess, store });
    client.onEvent = (roomId) => { if (state.sel && roomId === state.sel.room_id) renderThread(); };
    state.client = client;
    state.calls = new CallManager({ client, rtc: null }); // real deployment: rtc: browserRtc()
    state.calls.onIncoming = (call) => {
      if (confirm("Incoming call in " + call.roomId + " — answer?")) call.answer();
      else call.hangup();
    };
    // whoami: staff username is the localpart
    state.staff = sess.userId.split(":")[0].slice(1);
    client.start();
    $("login").hidden = true;
    $("hdr").hidden = false;
    $("main").hidden = false;
    $("who").textContent = sess.userId;
    // role badge: fetch own account record
    try {
      const { accounts } = await adminApi("GET", "/v1/accounts");
      const me = (accounts || []).find((a) => a.username === state.staff);
      if (me && me.role) { $("rolebadge").textContent = me.role; $("rolebadge").className = "badge " + me.role; }
    } catch { /* badge is cosmetic */ }
    pollQueue();
  } catch (err) {
    $("loginerr").textContent = "Sign-in failed: " + err.message;
  }
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
