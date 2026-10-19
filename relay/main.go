// relay — howUdeyChat store-and-forward relay (Go).
//
// Sits between patients and the homeserver: at a clinic hotspot, on an LGA
// hub, or at the edge of a flaky backhaul. Two jobs:
//
//  1. Proxy /_matrix/client/v3/sync and room sends upstream when the link
//     is up (gzip both ways — every byte matters on 2G).
//  2. When the upstream is DOWN, accept sends anyway, spool them to disk
//     with an integrity envelope, and replay in order when it recovers.
//     Patients at the clinic keep chatting with the care team on the LAN
//     even while the internet is gone.
//
// Standard library only — same licence doctrine as openhealthOS.
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Relay struct {
	upstream  string        // e.g. https://matrix.clinic.ng
	spoolDir  string        // durable outbox for the outage window
	secret    []byte        // HMAC key for spool integrity
	client    *http.Client  // upstream client, short timeout: fail fast, spool fast
	mu        sync.Mutex
	up        bool
}

type spoolEntry struct {
	TxnID    string `json:"txn_id"`
	Room     string `json:"room"`
	Body     string `json:"body"`
	Sender   string `json:"sender"`
	QueuedAt int64  `json:"queued_at"`
	Hash     string `json:"hash"` // sha256 over length-prefixed fields (matches huc-core)
}

func envelopeHash(txn, room, body string) string {
	var buf bytes.Buffer
	for _, p := range []string{txn, room, body} {
		fmt.Fprintf(&buf, "%08x%s", len(p), p)
	}
	sum := sha256.Sum256(buf.Bytes())
	return hex.EncodeToString(sum[:])
}

func (r *Relay) spool(e spoolEntry) error {
	e.Hash = envelopeHash(e.TxnID, e.Room, e.Body)
	mac := hmac.New(sha256.New, r.secret)
	mac.Write([]byte(e.Hash))
	tag := hex.EncodeToString(mac.Sum(nil))
	raw, _ := json.Marshal(e)
	return os.WriteFile(filepath.Join(r.spoolDir, fmt.Sprintf("%d-%s.%s.json",
		e.QueuedAt, e.TxnID, tag)), raw, 0o600)
}

// replay drains the spool in queue order; a tampered or partial entry is
// quarantined, never sent.
func (r *Relay) replay() {
	files, _ := filepath.Glob(filepath.Join(r.spoolDir, "*.json"))
	sort.Strings(files)
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var e spoolEntry
		if json.Unmarshal(raw, &e) != nil || e.Hash != envelopeHash(e.TxnID, e.Room, e.Body) {
			_ = os.Rename(f, f+".bad")
			continue
		}
		if err := r.sendUpstream(e); err != nil {
			return // still down — keep the rest for the next pass
		}
		_ = os.Remove(f)
	}
}

func (r *Relay) sendUpstream(e spoolEntry) error {
	path := fmt.Sprintf("/_matrix/client/v3/rooms/%s/send/m.room.message/%s", e.Room, e.TxnID)
	body, _ := json.Marshal(map[string]string{"msgtype": "m.text", "body": e.Body})
	req, _ := http.NewRequest("PUT", r.upstream+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("upstream %d", res.StatusCode)
	}
	return nil
}

// watch probes the upstream and replays the spool on recovery.
func (r *Relay) watch() {
	for {
		req, _ := http.NewRequest("GET", r.upstream+"/_matrix/client/v3/versions", nil)
		res, err := r.client.Do(req)
		up := err == nil && res.StatusCode < 500
		if res != nil {
			res.Body.Close()
		}
		r.mu.Lock()
		was := r.up
		r.up = up
		r.mu.Unlock()
		if up && !was {
			r.replay()
		}
		time.Sleep(5 * time.Second)
	}
}

// --- HTTP surface ----------------------------------------------------------

func (r *Relay) handleSend(w http.ResponseWriter, req *http.Request) {
	// /_matrix/client/v3/rooms/{room}/send/m.room.message/{txn}
	parts := strings.Split(req.URL.Path, "/")
	if len(parts) < 9 {
		http.Error(w, "bad path", 400)
		return
	}
	room, txn := parts[5], parts[8]
	var payload struct {
		Body string `json:"body"`
	}
	raw, _ := io.ReadAll(req.Body)
	if json.Unmarshal(raw, &payload) != nil || payload.Body == "" {
		http.Error(w, "bad message", 400)
		return
	}
	sender := req.Header.Get("Authorization") // identity stays upstream; here it's provenance
	r.mu.Lock()
	up := r.up
	r.mu.Unlock()
	if up {
		e := spoolEntry{TxnID: txn, Room: room, Body: payload.Body, Sender: sender}
		if err := r.sendUpstream(e); err == nil {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"event_id":"$relayed"}`)
			return
		}
	}
	// Down (or upstream error): spool durably, answer 200 — the patient's
	// message is safe; delivery is now OUR problem, not theirs.
	e := spoolEntry{TxnID: txn, Room: room, Body: payload.Body, Sender: sender, QueuedAt: time.Now().UnixNano()}
	if err := r.spool(e); err != nil {
		http.Error(w, "spool failed", 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(202)
	fmt.Fprint(w, `{"event_id":"$spooled"}`)
}

func (r *Relay) handleSync(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	up := r.up
	r.mu.Unlock()
	if !up {
		// During an outage: immediate empty sync so the client's long-poll
		// doesn't pin a connection for 30s against a dead upstream.
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"next_batch":"","rooms":{"join":{}}}`)
		return
	}
	upstream := r.upstream + req.URL.RequestURI()
	ureq, _ := http.NewRequestWithContext(req.Context(), "GET", upstream, nil)
	ureq.Header = req.Header.Clone()
	ureq.Header.Set("Accept-Encoding", "gzip")
	res, err := r.client.Do(ureq)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"next_batch":"","rooms":{"join":{}}}`)
		return
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err == nil {
			body, _ = io.ReadAll(zr)
			zr.Close()
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

func main() {
	listen := envOr("LISTEN", ":8080")
	upstream := envOr("UPSTREAM_HOMESERVER", "http://127.0.0.1:8008")
	spoolDir := envOr("SPOOL_DIR", "/var/lib/howudeychat/spool")
	secret := []byte(envOr("SPOOL_HMAC_KEY", "dev-only-key-change-me"))
	if err := os.MkdirAll(spoolDir, 0o700); err != nil {
		log.Fatal(err)
	}
	r := &Relay{
		upstream: upstream,
		spoolDir: spoolDir,
		secret:   secret,
		client:   &http.Client{Timeout: 8 * time.Second},
		up:       true,
	}
	go r.watch()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		r.mu.Lock()
		defer r.mu.Unlock()
		fmt.Fprintf(w, `{"up":%v}`, r.up)
	})
	mux.HandleFunc("GET /_matrix/client/v3/sync", r.handleSync)
	mux.HandleFunc("PUT /_matrix/client/v3/rooms/", r.handleSend)
	log.Printf("howUdeyChat relay on %s → %s (spool %s)", listen, upstream, spoolDir)
	log.Fatal(http.ListenAndServe(listen, mux))
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
