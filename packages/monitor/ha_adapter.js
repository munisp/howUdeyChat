// ha_adapter.js — Home Assistant -> passive-monitor signal bridge.
//
// Topology (deliberate): Mosquitto on the household hub, HA publishes
// sensor state over MQTT on loopback, and THIS adapter is a dumb pipe:
//
//   mosquitto_sub -h 127.0.0.1 -t 'homeassistant/#' -F '%t %p' \
//     | node ha_adapter.js --patient mama >> spool/signals.ndjson
//
// No MQTT client is embedded — mosquitto_sub (EPL/EDL, licence-clean)
// owns the wire; we own the translation. MQTT never leaves the premises;
// the spool/mesh carries everything beyond, so each technology sits in
// the layer it is actually robust at.
//
// Translation contract (fixture-pinned):
//   binary_sensor.*_motion        payload ON            -> presence signal
//   binary_sensor.*_contact       payload ON/OFF        -> presence signal
//   button.* / event.*            any state             -> checkin ("I'm okay")
//   sensor.*_battery              payload < 20          -> device alert
//   anything else / unparseable                          -> dropped, counted
// Fail-closed: a malformed line increments `dropped`, never crashes the
// pipe — a dead adapter must not look like a quiet patient.

export function translate(topic, payload, patient, now) {
  const t = String(topic || "");
  const p = String(payload || "").trim();
  const m = t.match(/^homeassistant\/(\w+)\/[\w-]+\/([\w-]+)\/state$/) ||
            t.match(/^homeassistant\/(\w+)\/([\w-]+)\/state$/);
  if (!m) return null;
  const [, domain, entity] = m;
  const base = { patient, source: "home-assistant", entity, at: now };

  if (domain === "binary_sensor" && /motion|contact|occupancy/.test(entity)) {
    if (p !== "ON" && p !== "OFF") return null;
    return { ...base, type: "presence", active: p === "ON" };
  }
  if (domain === "button" || domain === "event")
    return { ...base, type: "checkin" }; // physical "I'm okay" button
  if (domain === "sensor" && /battery/.test(entity)) {
    const pct = Number(p);
    if (!Number.isFinite(pct)) return null;
    return pct < 20 ? { ...base, type: "device-alert", battery_pct: pct } : null;
  }
  return null;
}

// Stream driver: NDJSON/topic lines in, signal objects out via onSignal.
export function makeLineHandler(patient, onSignal, clock = Date.now) {
  const stats = { seen: 0, emitted: 0, dropped: 0 };
  const handle = (line) => {
    const s = String(line).trim();
    if (!s) return;
    stats.seen++;
    const sp = s.indexOf(" ");
    const sig = sp === -1 ? null
      : translate(s.slice(0, sp), s.slice(sp + 1), patient, clock());
    if (sig) { stats.emitted++; onSignal(sig); } else stats.dropped++;
  };
  handle.stats = stats;
  return handle;
}

// CLI entry: node ha_adapter.js --patient mama   (stdin -> stdout NDJSON)
if (process.argv[1] && process.argv[1].endsWith("ha_adapter.js")) {
  const i = process.argv.indexOf("--patient");
  if (i === -1 || !process.argv[i + 1]) {
    process.stderr.write("usage: node ha_adapter.js --patient <id>\n");
    process.exit(2);
  }
  const patient = process.argv[i + 1];
  let buf = "";
  const emit = makeLineHandler(patient, (sig) =>
    process.stdout.write(JSON.stringify(sig) + "\n"));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) { emit(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  });
  process.stdin.on("end", () => {
    if (buf.trim()) emit(buf);
    process.stderr.write(`ha_adapter stats: ${JSON.stringify(emit.stats)}\n`);
  });
}
