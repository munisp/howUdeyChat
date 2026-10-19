#!/usr/bin/env python3
# demo/offline-chat.py — fake homeserver with Nigerian-network simulation.
# A control file (/tmp/huc-phase) switches the link: up | down | flaky.
# "flaky" = every other request fails, 300ms latency. Media bytes live in
# memory; events in a list; sync long-poll collapses to immediate reply.
import json, os, sys, time, random
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PHASE_FILE = "/tmp/huc-phase"
EVENTS = []   # pending inbound events for the client
SENT = []     # everything the client sent (for assertions)
MEDIA = {"mxc://hs.demo/xray1": (b"\x89PNG-fake-xray-bytes", "image/png"),
         "mxc://hs.demo/voice1": (b"OggS-fake-voice-note", "audio/ogg")}
SEQ = 0

def phase():
    try:
        return open(PHASE_FILE).read().strip()
    except OSError:
        return "up"

class H(BaseHTTPRequestHandler):
    def _j(self, obj, code=200):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _link_allows(self):
        p = phase()
        if p == "down":
            return False
        if p == "flaky":
            time.sleep(0.3)
            return random.random() > 0.5
        return True

    def _maybe_drop(self):
        if not self._link_allows():
            self.send_error(502, "link down")
            return True
        return False

    def do_GET(self):
        global EVENTS
        p = self.path.split("?")[0]
        if p == "/control/sent":
            return self._j({"sent": SENT})
        if self._maybe_drop():
            return
        if p == "/_matrix/client/v3/versions":
            return self._j({"versions": ["v1.8"]})
        if p == "/_matrix/client/v3/sync":
            evs, EVENTS = EVENTS, []
            rooms = {"!clinic:hs.demo": {"timeline": {"events": evs}}} if evs else {}
            return self._j({"next_batch": f"n{time.time()}", "rooms": {"join": rooms}})
        if p.startswith("/_matrix/media/v3/download/"):
            mxc = "mxc://" + "/".join(p.split("/")[5:])
            blob, mime = MEDIA.get(mxc, (b"", "application/octet-stream"))
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)
            return
        return self._j({}, 404)

    def do_PUT(self):
        if "/send/m.room.message/" in self.path:
            if self._maybe_drop():
                return
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            SENT.append(body)
            return self._j({"event_id": "$ok"})
        return self._j({}, 404)

    def log_message(self, *a):
        pass

def inject(ev):
    EVENTS.append(ev)

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18420
    # optional inbound scenario: a clinic that texts, sends an x-ray image,
    # a voice note, then an appointment artifact with a facility pin
    if os.environ.get("HUC_SCENARIO"):
        inject({"event_id": "$w1", "sender": "@clinic:hs.demo", "type": "m.room.message",
                "origin_server_ts": 1,
                "content": {"msgtype": "m.text", "body": "Welcome to Kawo PHC — Sannu!"}})
        inject({"event_id": "$w2", "sender": "@clinic:hs.demo", "type": "m.room.message",
                "origin_server_ts": 2,
                "content": {"msgtype": "m.image", "body": "Your x-ray", "url": "mxc://hs.demo/xray1"}})
        inject({"event_id": "$w3", "sender": "@clinic:hs.demo", "type": "m.room.message",
                "origin_server_ts": 3,
                "content": {"msgtype": "m.audio", "body": "Doctor's note", "url": "mxc://hs.demo/voice1"}})
        inject({"event_id": "$w4", "sender": "@clinic:hs.demo", "type": "m.room.message",
                "origin_server_ts": 4,
                "content": {"msgtype": "ng.openhealth.artifact", "artifact": "appointment",
                            "body": "ANC visit — Kawo PHC, Tue 08:00 (OH-KD-0001)",
                            "ng.openhealth": {"kind": "appointment", "title": "ANC visit",
                                              "facility": "Kawo PHC", "when": "Tue 08:00",
                                              "lat": 10.5203, "lon": 7.4401, "ref": "OH-KD-0001"}}})
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
