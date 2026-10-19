// demo/phase5.mjs — staff engagement e2e:
// provision staff (licence-gated) -> activate -> patient escalates ->
// doctor claims -> doctor chats with patient over Matrix -> resolve.
import { MatrixLite } from "../packages/matrix-lite/client.js";
import { MemoryStore } from "../packages/matrix-lite/store-memory.js";

const ADMIN = "http://127.0.0.1:18441";
const HS = "http://127.0.0.1:18420";
const TOKEN = "demo-mgmt-token";
const ROOM = "!care-1:demo";

let passed = 0;
function ok(name, cond) {
  if (!cond) { console.error("FAIL:", name); process.exit(1); }
  passed++; console.log("  ok -", name);
}

async function api(method, path, body, auth = true) {
  const res = await fetch(ADMIN + path, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer " + TOKEN } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// 1. staff provisioning is gated by the licence registry
let r = await api("POST", "/v1/staff/provision", { licence: "MDCN-0000", role: "doctor", phone: "08022223333" });
ok("phantom licence -> 404", r.status === 404);
r = await api("POST", "/v1/staff/provision", { licence: "MDCN-4521", role: "nurse", phone: "08022223333" });
ok("licence/role mismatch -> 404", r.status === 404);
r = await api("POST", "/v1/staff/provision", { licence: "MDCN-4521", role: "doctor", phone: "08022223333", display_name: "Dr. Eze" });
ok("doctor provisioned (MDCN-4521)", r.status === 201 && r.body.username === "mdcn-4521" && r.body.setup_code);
const docCode = r.body.setup_code;

// 2. staff activation fails closed, then succeeds
r = await api("POST", "/v1/staff/activate", { username: "mdcn-4521", setup_code: "WRONGCODE1", licence: "MDCN-4521", phone: "08022223333", pin: "4321" }, false);
ok("wrong setup code -> 404", r.status === 404);
r = await api("POST", "/v1/staff/activate", { username: "mdcn-4521", setup_code: docCode, licence: "MDCN-4521", phone: "08022223333", pin: "4321" }, false);
ok("doctor activated, role returned", r.status === 200 && r.body.role === "doctor");

// 3. a patient (already provisioned flow) escalates to a human
r = await api("POST", "/v1/provision", { patient_id: "OH-KD-0001", phone: "08011112222", display_name: "Amina Bello" });
ok("patient provisioned", r.status === 201);
const patCode = r.body.setup_code;
r = await api("POST", "/v1/activate", { username: "oh-kd-0001", setup_code: patCode, patient_id: "OH-KD-0001", phone: "08011112222", pin: "1234" }, false);
ok("patient activated", r.status === 200);

r = await api("POST", "/v1/escalate", { username: "oh-kd-0001", room_id: ROOM, reason: "chest pain since morning" }, false);
ok("patient escalated -> waiting", r.status === 201 && r.body.status === "waiting");
const escId = r.body.id;
r = await api("POST", "/v1/escalate", { username: "ghost", room_id: "!x:demo" }, false);
ok("phantom escalate -> 404", r.status === 404);
r = await api("POST", "/v1/escalate", { username: "oh-kd-0001", room_id: ROOM, reason: "still waiting" }, false);
ok("re-escalate idempotent", r.status === 200);

// 4. queue + claiming
r = await api("GET", "/v1/queue");
ok("queue shows one waiting patient", r.body.count === 1 && r.body.queue[0].id === escId);
r = await api("POST", "/v1/queue/claim", { id: escId, staff_username: "oh-kd-0001" });
ok("patient cannot claim -> 404", r.status === 404);
r = await api("POST", "/v1/queue/claim", { id: escId, staff_username: "mdcn-4521" });
ok("doctor claims the patient", r.status === 200 && r.body.room_id === ROOM);

// 5. doctor and patient talk over Matrix (staff console == matrix-lite client)
const staff = new MatrixLite({ homeserver: HS, accessToken: "a", userId: "@mdcn-4521:demo", store: new MemoryStore() });
const patient = new MatrixLite({ homeserver: HS, accessToken: "c", userId: "@oh-kd-0001:demo", store: new MemoryStore() });
let patientGot = null, staffGot = null;
patient.onEvent = (_r, ev) => { if (ev.type === "m.room.message") patientGot = ev; };
staff.onEvent = (_r, ev) => { if (ev.type === "m.room.message") staffGot = ev; };

await staff.send(ROOM, "Hello Amina, this is Dr. Eze. Tell me about the chest pain.");
const deadline = Date.now() + 5000;
while (!patientGot && Date.now() < deadline) await onceSync(patient);
ok("patient received doctor's message", patientGot && patientGot.content.body.includes("Dr. Eze"));

await patient.send(ROOM, "It burns when I breathe, doctor.");
const dl2 = Date.now() + 5000;
while (!staffGot && Date.now() < dl2) await onceSync(staff);
ok("doctor received patient's reply", staffGot && staffGot.content.body.includes("burns"));

staff.stop?.(); patient.stop?.();

// 6. resolve closes the loop
r = await api("POST", "/v1/queue/resolve", { id: escId, staff_username: "mdcn-4521" });
ok("doctor resolves", r.status === 200);
r = await api("GET", "/v1/queue");
ok("queue empty after resolve", r.body.count === 0);

console.log(`PHASE5: ALL GREEN (${passed} checks)`);

async function onceSync(client) {
  // drive one sync iteration directly against the stub
  await client._req("GET", "/_matrix/client/v3/sync?timeout=0").then((d) => client._applySync(d)).catch(() => {});
}
