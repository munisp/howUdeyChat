#!/bin/sh
# demo/offline-chat.sh — e2e: howUdeyChat client core vs a simulated
# Nigerian network (up → down → flaky → up), with rich media + artifacts.
set -eu
cd "$(dirname "$0")/.."
echo "up" > /tmp/huc-phase
HUC_SCENARIO=1 python3 demo/offline-chat.py 18420 &
HS_PID=$!
trap 'kill $HS_PID 2>/dev/null || true' EXIT
sleep 1
node demo/offline-chat.mjs
