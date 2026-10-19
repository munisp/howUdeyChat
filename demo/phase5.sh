#!/bin/sh
# demo/phase5.sh — staff engagement e2e: licence-gated staff provisioning,
# escalation queue, doctor <-> patient chat over Matrix, resolve.
set -eu
cd "$(dirname "$0")/.."
echo "up" > /tmp/huc-phase
DATA=/tmp/huc-admin-p5
rm -rf "$DATA" && mkdir -p "$DATA"

python3 demo/offline-chat.py 18420 &
HS_PID=$!
python3 demo/admin-demo.py &
STUB_PID=$!
(cd admin && go build -o /tmp/huc-admin .)
LISTEN=":18441" \
HOMESERVER="http://127.0.0.1:18440" \
REGISTRY_URL="http://127.0.0.1:18440" \
SYNAPSE_SHARED_SECRET="demo-shared-secret" \
MGMT_TOKEN="demo-mgmt-token" \
USERNAME_REALM="demo" \
DATA_DIR="$DATA" \
/tmp/huc-admin &
ADMIN_PID=$!
trap 'kill $HS_PID $STUB_PID $ADMIN_PID 2>/dev/null || true' EXIT

for i in $(seq 1 50); do
  curl -sf http://127.0.0.1:18441/healthz >/dev/null 2>&1 && curl -sf http://127.0.0.1:18440/control/state >/dev/null 2>&1 && break
  sleep 0.1
done

node demo/phase5.mjs
