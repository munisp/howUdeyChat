#!/bin/sh
# demo/admin.sh — end-to-end provisioning flow against a fake homeserver+registry.
set -eu
cd "$(dirname "$0")/.."

PORT_STUB=18440
PORT_ADMIN=18441
DATA=/tmp/huc-admin-demo
rm -rf "$DATA"
mkdir -p "$DATA"

python3 demo/admin-demo.py &
STUB_PID=$!
trap 'kill $STUB_PID $ADMIN_PID 2>/dev/null || true' EXIT

(cd admin && go build -o /tmp/huc-admin .)
LISTEN=":$PORT_ADMIN" \
HOMESERVER="http://127.0.0.1:$PORT_STUB" \
REGISTRY_URL="http://127.0.0.1:$PORT_STUB" \
SYNAPSE_SHARED_SECRET="demo-shared-secret" \
MGMT_TOKEN="demo-mgmt-token" \
USERNAME_REALM="demo" \
DATA_DIR="$DATA" \
/tmp/huc-admin &
ADMIN_PID=$!

ok() { echo "  ok - $1"; }
fail() { echo "FAIL: $1"; exit 1; }

# wait for both
for i in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT_ADMIN/healthz" >/dev/null 2>&1 && curl -sf "http://127.0.0.1:$PORT_STUB/control/state" >/dev/null 2>&1 && break
  sleep 0.1
done

echo "[1] provision patient OH-KD-0001 (clinic registration desk)"
RESP=$(curl -sf -X POST "http://127.0.0.1:$PORT_ADMIN/v1/provision" \
  -H "Authorization: Bearer demo-mgmt-token" -H 'Content-Type: application/json' \
  -d '{"patient_id":"OH-KD-0001","phone":"08011112222","display_name":"Amina Bello"}')
echo "$RESP" | grep -q '"username":"oh-kd-0001"' || fail "username derivation"
CODE=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["setup_code"])')
[ -n "$CODE" ] || fail "setup code issued"
ok "provisioned -> username oh-kd-0001, setup code issued (printed card)"

echo "[2] matrix account created on homeserver"
STATE=$(curl -sf "http://127.0.0.1:$PORT_STUB/control/state")
echo "$STATE" | grep -q 'oh-kd-0001' || fail "homeserver account"
ok "shared-secret registration accepted by homeserver"

echo "[3] phantom patient rejected by registry gate"
CODE404=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT_ADMIN/v1/provision" \
  -H "Authorization: Bearer demo-mgmt-token" -H 'Content-Type: application/json' \
  -d '{"patient_id":"OH-XX-9999","phone":"08000000000"}')
[ "$CODE404" = "404" ] || fail "phantom patient got $CODE404"
ok "unknown patient -> 404"

echo "[4] activation fails closed on wrong setup code"
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT_ADMIN/v1/activate" \
  -H 'Content-Type: application/json' \
  -d '{"username":"oh-kd-0001","patient_id":"OH-KD-0001","phone":"08011112222","setup_code":"WRONGCODE1","pin":"4321"}')
[ "$BAD" = "404" ] || fail "wrong code got $BAD"
ok "wrong code -> 404 (indistinguishable from unknown account)"

echo "[5] activation fails closed on wrong phone binding"
BAD2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT_ADMIN/v1/activate" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"oh-kd-0001\",\"patient_id\":\"OH-KD-0001\",\"phone\":\"2348099990000\",\"setup_code\":\"$CODE\",\"pin\":\"4321\"}")
[ "$BAD2" = "404" ] || fail "wrong phone got $BAD2"
ok "phone must match registry record"

echo "[6] correct activation sets PIN, logs out other devices"
curl -sf -X POST "http://127.0.0.1:$PORT_ADMIN/v1/activate" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"oh-kd-0001\",\"patient_id\":\"OH-KD-0001\",\"phone\":\"08011112222\",\"setup_code\":\"$CODE\",\"pin\":\"4321\"}" >/dev/null
STATE=$(curl -sf "http://127.0.0.1:$PORT_STUB/control/state")
echo "$STATE" | python3 -c 'import sys,json; s=json.load(sys.stdin); assert s["passwords"].get("@oh-kd-0001:demo")=="4321", s' || fail "PIN not set on homeserver"
ok "password set -> patient can now log in"

echo "[7] setup code is single-use (burned on activation)"
REPLAY=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT_ADMIN/v1/activate" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"oh-kd-0001\",\"patient_id\":\"OH-KD-0001\",\"phone\":\"08011112222\",\"setup_code\":\"$CODE\",\"pin\":\"9999\"}")
[ "$REPLAY" = "404" ] || fail "replay got $REPLAY"
ok "replayed code -> 404"

echo "[8] management endpoints require the management token"
NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_ADMIN/v1/accounts")
[ "$NOAUTH" = "401" ] || fail "accounts without token got $NOAUTH"
ok "no token -> 401"

echo "[9] revoke deactivates the matrix account"
curl -sf -X POST "http://127.0.0.1:$PORT_ADMIN/v1/revoke" \
  -H "Authorization: Bearer demo-mgmt-token" -H 'Content-Type: application/json' \
  -d '{"username":"oh-kd-0001","reason":"device lost"}' >/dev/null
STATE=$(curl -sf "http://127.0.0.1:$PORT_STUB/control/state")
echo "$STATE" | python3 -c 'import sys,json; s=json.load(sys.stdin); assert "@oh-kd-0001:demo" in s["deactivated"], s' || fail "not deactivated"
ok "revoked -> homeserver account deactivated"

echo "[10] audit trail written"
grep -q 'provision' "$DATA/audit.log" && grep -q 'activate' "$DATA/audit.log" && grep -q 'revoke' "$DATA/audit.log" || fail "audit log incomplete"
ok "audit.log has provision/activate/revoke entries"

echo "ADMIN DEMO: ALL GREEN"
