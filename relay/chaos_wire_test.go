// chaos_wire_test.go — the WAN rig, on real sockets.
//
// chaos_mesh_test.go injected the wild at the in-process transport seam;
// ADR-0014 recorded what it could NOT cover: real sockets, TCP behaviour,
// WAN latency. This file closes most of that: real TLS servers (httptest),
// a real HTTP client with keep-alive, and a RoundTripper that injects
// what the rainy season injects:
//
//   - LATENCY: every round trip sleeps a seeded 50-400ms (VSAT/harmattan
//     profile) — correctness under latency is what we assert; wall time
//     is recorded, never asserted (load doctrine);
//   - CONNECTION FAILURE: a fraction of dials fail outright (tower down)
//     — Drain stops, entries stay spooled, the retry loop lands all;
//   - SLOW PEER: the hub server itself delays responses (a loaded LGA
//     relay) — the source's retry loop must not duplicate deliveries.
//
// What remains honestly out of scope: multi-host clock skew and true
// packet loss mid-stream (both need real network namespaces). TLS is
// self-signed loopback — the crypto path is real, the PKI is not.

package main

import (
	"bytes"
	"crypto/tls"
	"errors"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// wanTransport injects latency and dial failure around a real transport.
type wanTransport struct {
	base     http.RoundTripper
	rng      *rand.Rand
	minLat   time.Duration
	maxLat   time.Duration
	failRate float64
	calls    int
	failures int
}

func (w *wanTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	w.calls++
	lat := w.minLat + time.Duration(w.rng.Int63n(int64(w.maxLat-w.minLat)))
	time.Sleep(lat) // the satellite does not hurry
	if w.rng.Float64() < w.failRate {
		w.failures++
		return nil, errors.New("chaos: tower unreachable")
	}
	return w.base.RoundTrip(req)
}

func wanClient(w *wanTransport) *http.Client {
	w.base = &http.Transport{
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true}, // test only
		MaxIdleConnsPerHost: 4,
	}
	return &http.Client{Transport: w, Timeout: 30 * time.Second}
}

// wanHub is a real TLS intake server; slowMs simulates a loaded relay.
func wanHub(t *testing.T, secret []byte, spoolDir string, slowMs int) *httptest.Server {
	t.Helper()
	hub := NewMesh("hub", secret, func(string, []byte) error { return nil })
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if slowMs > 0 {
			time.Sleep(time.Duration(slowMs) * time.Millisecond)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read failed", 400)
			return
		}
		if err := hub.Intake(body, spoolDir); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func seedSpool(t *testing.T, dir string, n int, base int64) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, e := range mkSpoolEntries(n, base) {
		raw, _ := json.Marshal(e)
		os.WriteFile(fmt.Sprintf("%s/%d-%s.%s.json", dir, e.QueuedAt, e.TxnID, e.Hash[:8]), raw, 0o600)
	}
}

func TestWANLatencyAndFailureZeroLoss(t *testing.T) {
	secret := []byte("wan-chaos-secret-32-bytes-padded-00")
	hubSpool := t.TempDir()
	srcSpool := t.TempDir()
	srv := wanHub(t, secret, hubSpool, 0)

	wan := &wanTransport{rng: rand.New(rand.NewSource(2026)),
		minLat: 10 * time.Millisecond, maxLat: 60 * time.Millisecond,
		failRate: 0.25}
	src := NewMesh("src", secret, meshPostWithClient(wanClient(wan)))

	const n = 40
	seedSpool(t, srcSpool, n, 2_200_000_000)

	start := time.Now()
	for spoolCount(t, hubSpool) < n {
		if _, err := src.Drain(srcSpool, srv.URL); err != nil {
			continue // tower down: entries stayed spooled
		}
	}
	el := time.Since(start).Round(time.Millisecond)

	if got := spoolCount(t, hubSpool); got != n {
		t.Fatalf("loss over WAN chaos: %d of %d", got, n)
	}
	if wan.failures == 0 {
		t.Fatal("failure chaos never fired — spike would prove nothing")
	}
	t.Logf("WAN drain: %d entries over %d round trips (%d tower failures), %v",
		n, wan.calls, wan.failures, el)
}

func TestWANSlowPeerNoDuplicates(t *testing.T) {
	secret := []byte("wan-chaos-secret-32-bytes-padded-00")
	hubSpool := t.TempDir()
	srcSpool := t.TempDir()
	srv := wanHub(t, secret, hubSpool, 15) // loaded LGA relay

	wan := &wanTransport{rng: rand.New(rand.NewSource(77)),
		minLat: time.Millisecond, maxLat: 5 * time.Millisecond}
	src := NewMesh("src", secret, meshPostWithClient(wanClient(wan)))

	const n = 25
	seedSpool(t, srcSpool, n, 2_300_000_000)
	for spoolCount(t, hubSpool) < n {
		if _, err := src.Drain(srcSpool, srv.URL); err != nil {
			continue
		}
	}
	if got := spoolCount(t, hubSpool); got != n {
		t.Fatalf("slow-peer duplication or loss: %d of %d", got, n)
	}
}

func TestWANDuplicateDeliveryRefusedOverTLS(t *testing.T) {
	// The retry-that-actually-succeeded case, on the wire: POST the same
	// bytes twice to the real server — the second must come back 400.
	secret := []byte("wan-chaos-secret-32-bytes-padded-00")
	hubSpool := t.TempDir()
	srv := wanHub(t, secret, hubSpool, 0)

	src := NewMesh("src", secret, meshPostWithClient(wireClient()))
	e := mkSpoolEntries(1, 2_400_000_000)[0]
	if err := src.Forward(e, srv.URL); err != nil {
		t.Fatalf("first delivery: %v", err)
	}
	// rebuild the identical wire bytes: same entry, same genesis hop
	src2 := NewMesh("src", secret, meshPostWithClient(wireClient()))
	err := src2.Forward(e, srv.URL)
	if err == nil {
		t.Fatal("duplicate wire delivery accepted")
	}
	if got := spoolCount(t, hubSpool); got != 1 {
		t.Fatalf("hub spool holds %d, want 1", got)
	}
}

func TestWANTamperedBytesRejectedOverTLS(t *testing.T) {
	secret := []byte("wan-chaos-secret-32-bytes-padded-00")
	hubSpool := t.TempDir()
	srv := wanHub(t, secret, hubSpool, 0)

	e := mkSpoolEntries(1, 2_500_000_000)[0]
	var captured []byte
	capture := NewMesh("src", secret, func(_ string, body []byte) error {
		captured = append([]byte(nil), body...)
		return nil
	})
	if err := capture.Forward(e, "unused"); err != nil {
		t.Fatal(err)
	}
	// flip one byte inside the payload region
	captured[len(captured)/2] ^= 0xFF
	resp, err := wireClient().Post(srv.URL+"/mesh/intake", "application/json",
		bytes.NewReader(captured))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 {
		t.Fatal("tampered bytes accepted over TLS")
	}
	if got := spoolCount(t, hubSpool); got != 0 {
		t.Fatalf("tampered entry landed in spool (%d)", got)
	}
}
