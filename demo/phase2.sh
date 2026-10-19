#!/bin/sh
# demo/phase2.sh — e2e of the phase-2 gap list: E2EE, calls, reactions.
set -eu
cd "$(dirname "$0")/.."
echo "up" > /tmp/huc-phase
python3 demo/offline-chat.py 18420 &
HS_PID=$!
trap 'kill $HS_PID 2>/dev/null || true' EXIT
sleep 1
node demo/phase2.mjs
