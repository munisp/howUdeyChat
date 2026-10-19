package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func newTestRelay(t *testing.T, upstream string) *Relay {
	t.Helper()
	dir := t.TempDir()
	return &Relay{
		upstream: upstream,
		spoolDir: dir,
		secret:   []byte("test-key"),
		client:   http.DefaultClient,
		up:       true,
	}
}

func putSend(t *testing.T, r *Relay, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("PUT",
		"/_matrix/client/v3/rooms/!r1:hs/send/m.room.message/txn-1",
		strings.NewReader(`{"msgtype":"m.text","body":`+body+`}`))
	rec := httptest.NewRecorder()
	r.handleSend(rec, req)
	return rec
}

func TestSendRelaysWhenUpstreamUp(t *testing.T) {
	var got atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"event_id":"$ok"}`))
	}))
	defer up.Close()
	r := newTestRelay(t, up.URL)
	rec := putSend(t, r, `"hello clinic"`)
	if rec.Code != 200 || got.Load() != 1 {
		t.Fatalf("want relayed 200 + 1 upstream call, got %d / %d", rec.Code, got.Load())
	}
	files, _ := filepath.Glob(r.spoolDir + "/*.json")
	if len(files) != 0 {
		t.Fatal("spool must stay empty when upstream is up")
	}
}

func TestSendSpoolsWhenUpstreamDown(t *testing.T) {
	r := newTestRelay(t, "http://127.0.0.1:1") // dead
	r.up = false
	rec := putSend(t, r, `"hello clinic"`)
	if rec.Code != 202 {
		t.Fatalf("want 202 spooled, got %d", rec.Code)
	}
	files, _ := filepath.Glob(r.spoolDir + "/*.json")
	if len(files) != 1 {
		t.Fatalf("want 1 spooled message, got %d", len(files))
	}
}

func TestReplayOnRecoveryInOrder(t *testing.T) {
	var sent []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p struct{ Body string `json:"body"` }
		_ = json.NewDecoder(r.Body).Decode(&p)
		sent = append(sent, p.Body)
		w.Write([]byte(`{"event_id":"$ok"}`))
	}))
	defer up.Close()
	r := newTestRelay(t, "http://127.0.0.1:1")
	r.up = false
	putSend(t, r, `"first"`)
	putSend(t, r, `"second"`)
	// upstream recovers
	r.upstream = up.URL
	r.replay()
	if len(sent) != 2 || sent[0] != "first" || sent[1] != "second" {
		t.Fatalf("want ordered replay [first second], got %v", sent)
	}
	files, _ := filepath.Glob(r.spoolDir + "/*.json")
	if len(files) != 0 {
		t.Fatal("spool must be drained after replay")
	}
}

func TestTamperedSpoolEntryIsQuarantined(t *testing.T) {
	r := newTestRelay(t, "http://127.0.0.1:1")
	r.up = false
	putSend(t, r, `"honest"`)
	files, _ := filepath.Glob(r.spoolDir + "/*.json")
	if len(files) != 1 {
		t.Fatal("need one spool file")
	}
	// tamper: flip the body after the hash was computed
	raw, _ := os.ReadFile(files[0])
	tampered := strings.Replace(string(raw), "honest", "forged ", 1)
	_ = os.WriteFile(files[0], []byte(tampered), 0o600)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("tampered entry must never reach the upstream")
	}))
	defer up.Close()
	r.upstream = up.URL
	r.replay()
	bad, _ := filepath.Glob(r.spoolDir + "/*.bad")
	if len(bad) != 1 {
		t.Fatal("tampered entry must be quarantined as .bad")
	}
}

func TestSyncAnswersImmediatelyWhenDown(t *testing.T) {
	r := newTestRelay(t, "http://127.0.0.1:1")
	r.up = false
	req := httptest.NewRequest("GET", "/_matrix/client/v3/sync?timeout=30000", nil)
	rec := httptest.NewRecorder()
	r.handleSync(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"rooms"`) {
		t.Fatalf("want immediate empty sync, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestEnvelopeHashUnambiguous(t *testing.T) {
	if envelopeHash("ab", "c", "x") == envelopeHash("a", "bc", "x") {
		t.Fatal("length-prefixing must disambiguate field boundaries")
	}
}
