// ha-adapter.test.mjs — Home Assistant bridge, fixture-pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { translate, makeLineHandler } from "../packages/monitor/ha_adapter.js";
import { assess } from "../packages/monitor/monitor.js";

const NOW = 1_700_000_000_000;

test("ha: motion/contact -> presence, button -> checkin, low battery -> device alert", () => {
  assert.deepEqual(
    translate("homeassistant/binary_sensor/hallway_motion/state", "ON", "mama", NOW),
    { patient: "mama", source: "home-assistant", entity: "hallway_motion",
      at: NOW, type: "presence", active: true });
  assert.equal(
    translate("homeassistant/binary_sensor/front_door_contact/state", "OFF", "mama", NOW).active,
    false);
  assert.equal(
    translate("homeassistant/button/bedside_ok/state", "2026-10-22T07:15:00", "mama", NOW).type,
    "checkin");
  assert.equal(
    translate("homeassistant/sensor/hallway_motion_battery/state", "12", "mama", NOW).type,
    "device-alert");
});

test("ha: unknown topics and malformed payloads drop, never crash", () => {
  assert.equal(translate("homeassistant/light/kitchen/state", "ON", "mama", NOW), null);
  assert.equal(translate("weird/topic", "ON", "mama", NOW), null);
  assert.equal(translate("homeassistant/sensor/x_battery/state", "abc", "mama", NOW), null);
  assert.equal(translate("homeassistant/binary_sensor/hallway_motion/state", "GARBAGE", "mama", NOW), null);
});

test("ha: stream handler counts seen/emitted/dropped honestly", () => {
  const got = [];
  const h = makeLineHandler("mama", (s) => got.push(s), () => NOW);
  h("homeassistant/binary_sensor/hallway_motion/state ON");
  h("homeassistant/light/kitchen/state ON");   // dropped: not a care signal
  h("garbage line with no topic shape");       // dropped
  h("homeassistant/button/bedside_ok/state pressed");
  assert.equal(got.length, 2);
  assert.deepEqual(h.stats, { seen: 4, emitted: 2, dropped: 2 });
});

test("ha: a morning of sensor signals feeds the monitor and stays quiet", () => {
  // captured-fixture realism: motion at 06:30, bedside button at 07:15
  const day = new Date("2026-10-22T12:00:00").getTime();
  const signals = [
    translate("homeassistant/binary_sensor/hallway_motion/state", "ON", "mama", day - 5.5 * 3600e3),
    translate("homeassistant/button/bedside_ok/state", "pressed", "mama", day - 4.75 * 3600e3),
  ];
  const checkins = signals.filter((s) => s.type === "checkin");
  const alerts = assess({ checkins, meds: [] }, [{ id: "mama", role: "owner" }], day);
  assert.deepEqual(alerts, []); // an active morning is correctly quiet
});
