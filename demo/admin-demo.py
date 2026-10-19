#!/usr/bin/env python3
"""Fake Synapse admin API + fake OpenHealth registry for the admin demo."""
import hashlib, hmac, json, re
from http.server import BaseHTTPRequestHandler, HTTPServer

NONCE = "demo-nonce-123"
SHARED_SECRET = "demo-shared-secret"
CREATED = []   # usernames created via shared-secret registration
DEACTIVATED = []
PASSWORDS = {} # username -> last set password

# registry: patient_id -> phone
REGISTRY = {"OH-KD-0001": "2348011112222", "OH-KD-0002": "2348099990000"}
# staff registry: licence -> (role, phone)
STAFF = {"MDCN-4521": ("doctor", "2348022223333"), "NMCN-8890": ("nurse", "2348033334444")}


def norm_phone(p):
    p = re.sub(r"\D", "", p or "")
    if p.startswith("0"):
        p = "234" + p[1:]
    return p


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def do_GET(self):
        if self.path.startswith("/_synapse/admin/v1/register"):
            return self._json(200, {"nonce": NONCE})
        if self.path.startswith("/patients/search"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            pid = q.get("id", q.get("patient_id", [""]))[0]
            phone = norm_phone(q.get("phone", [""])[0])
            if pid in REGISTRY and (not phone or REGISTRY[pid] == phone):
                return self._json(200, {"results": [{"patient_id": pid, "phone": REGISTRY[pid]}]})
            return self._json(200, {"results": []})
        if self.path.startswith("/staff/search"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            lic = q.get("licence", [""])[0]
            role = q.get("role", [""])[0]
            phone = norm_phone(q.get("phone", [""])[0])
            if lic in STAFF and STAFF[lic] == (role, phone):
                return self._json(200, {"results": [{"licence": lic, "role": role}]})
            return self._json(200, {"results": []})
        if self.path == "/control/state":
            return self._json(200, {"created": CREATED, "deactivated": DEACTIVATED, "passwords": PASSWORDS})
        self._json(404, {"err": "not found"})

    def do_POST(self):
        if self.path.startswith("/_synapse/admin/v1/register"):
            b = self._body()
            mac = hmac.new(SHARED_SECRET.encode(), digestmod=hashlib.sha1)
            for part in (b["nonce"], b["username"], b["password"], "notadmin"):
                mac.update(part.encode())
                mac.update(b"\x00")
            if b.get("mac") != mac.hexdigest():
                return self._json(403, {"err": "bad mac"})
            CREATED.append(b["username"])
            return self._json(200, {"user_id": "@%s:demo" % b["username"]})
        m = re.match(r"/_synapse/admin/v2/users/(@[^/]+)$", self.path)
        if m:  # password reset (POST with new_password)
            b = self._body()
            if "new_password" in b:
                PASSWORDS[m.group(1)] = b["new_password"]
                return self._json(200, {})
        self._json(404, {"err": "not found"})

    def do_PUT(self):
        m = re.match(r"/_synapse/admin/v2/users/(@[^/]+)$", self.path)
        if m:
            b = self._body()
            if b.get("deactivated"):
                DEACTIVATED.append(m.group(1))
                return self._json(200, {})
        self._json(404, {"err": "not found"})


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 18440), H).serve_forever()
