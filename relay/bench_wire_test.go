package main

// bench_wire_test.go — wire-level mesh benchmark: real TCP + TLS.
//
// The in-process bench (bench_mesh_test.go) proved crypto+persist is
// cheap; this measures what it didn't: TLS handshake cost, connection
// reuse (keep-alive), and HTTP round-trip per hop. Loopback, self-signed
// cert — latency is near-zero, so what remains is the PROTOCOL cost:
// handshakes, framing, syscall overhead. Honest scope note: WAN latency
// and packet loss are NOT simulated here; that needs the chaos harness.

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func wireClient() *http.Client {
	return &http.Client{Transport: &http.Transport{
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true}, // bench only
		MaxIdleConns:        8,
		MaxIdleConnsPerHost: 8, // keep-alive: the steady-state regime
	}}
}

// meshPostWithClient mirrors Mesh's default postFn but with a caller's
// client, so the bench controls connection reuse.
func meshPostWithClient(c *http.Client) func(string, []byte) error {
	return func(peer string, body []byte) error {
		resp, err := c.Post(peer+"/mesh/intake", "application/json", bytes.NewReader(body))
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != 200 {
			return fmt.Errorf("peer %s: status %d", peer, resp.StatusCode)
		}
		return nil
	}
}

func mustReadDir(b *testing.B, dir string) []os.DirEntry {
	entries, err := os.ReadDir(dir)
	if err != nil {
		b.Fatal(err)
	}
	return entries
}

func benchWire(b *testing.B, n int, reuse bool) (hopEps float64) {
	dir := b.TempDir()
	secret := []byte("bench-secret-32-bytes-padded-00000000")
	if err := os.MkdirAll(dir+"/wire-spool", 0o700); err != nil {
		b.Fatal(err)
	}

	hub := NewMesh("hub", secret, func(string, []byte) error { return nil })
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read failed", 400)
			return
		}
		if err := hub.Intake(body, dir+"/wire-spool"); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
	}))
	defer srv.Close()

	client := wireClient()
	var postFn func(string, []byte) error
	postFn = meshPostWithClient(client) // keep-alive client
	if !reuse {
		postFn = func(peer string, body []byte) error {
			c := &http.Client{Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			}}
			defer c.CloseIdleConnections()
			return meshPostWithClient(c)(peer, body) // fresh handshake per hop
		}
	}
	clinic := NewMesh("clinic", secret, postFn)

	t0 := time.Now()
	for i := 0; i < n; i++ {
		e := spoolEntry{TxnID: fmt.Sprintf("wire-%08d", i), Room: "ward",
			Body:  fmt.Sprintf("payload-body-%d", i),
			Sender: "bench", QueuedAt: time.Now().UnixNano()}
		e.Hash = envelopeHash(e.TxnID, e.Room, e.Body)
		if err := clinic.Forward(e, srv.URL); err != nil {
			b.Fatalf("wire hop %d failed: %v", i, err)
		}
	}
	el := time.Since(t0).Seconds()
	b.Logf("intake spool size: %d entries expected %d", len(mustReadDir(b, dir+"/wire-spool")), n)
	return float64(n) / el
}

func BenchmarkWireKeepAlive(b *testing.B) {
	b.ReportMetric(benchWire(b, 2000, true), "hop_eps")
}

func BenchmarkWireHandshakePerHop(b *testing.B) {
	b.ReportMetric(benchWire(b, 200, false), "hop_eps") // fewer: handshakes are expensive
}
