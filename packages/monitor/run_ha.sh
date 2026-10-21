#!/bin/sh
# run_ha.sh — live Home Assistant bridge bring-up. Honest failure: no
# mosquitto_sub or no reachable broker => exit 2, fixtures stay golden.
set -eu
cd "$(dirname "$0")"

if ! command -v mosquitto_sub >/dev/null 2>&1; then
  echo "ERROR: mosquitto_sub not installed — the MQTT wire is not embeddable" >&2
  echo "by design. apt install mosquitto-clients on the hub, then re-run." >&2
  exit 2
fi
BROKER="${HA_MQTT_HOST:-127.0.0.1}"
if ! mosquitto_sub -h "$BROKER" -t '$SYS/broker/version' -C 1 -W 5 >/dev/null 2>&1; then
  echo "ERROR: no MQTT broker at $BROKER — start Mosquitto + Home Assistant first." >&2
  exit 2
fi
PATIENT="${1:-mama}"
echo "bridging homeassistant/# on $BROKER for patient '$PATIENT' -> stdout"
exec mosquitto_sub -h "$BROKER" -t 'homeassistant/#' -F '%t %p' \
  | node ha_adapter.js --patient "$PATIENT"
