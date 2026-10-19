#!/bin/sh
# demo/phase3.sh — e2e of phase 3: group calls (SFU seam), editing, device sync.
set -eu
cd "$(dirname "$0")/.."
echo "up" > /tmp/huc-phase
python3 demo/offline-chat.py 18420 &
HS_PID=$!
trap 'kill $HS_PID 2>/dev/null || true' EXIT
sleep 1
node demo/phase3.mjs
