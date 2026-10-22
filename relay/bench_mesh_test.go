package main

// bench_mesh.go — mesh throughput harness.
//
// Honest measurement of the two hot paths:
//   hop  = Forward + Intake (chain-MAC append, wire marshal, payload-hash
//          + chain verify + dedupe + spool persist) — the per-hop cost
//   drain = ordered spool flush to a peer after a partition heals
// Timing is reported via ReportMetric, never asserted (hardware varies);
// correctness (every entry intaked, every entry drained) IS asserted.

import (
	"fmt"
	"os"
	"testing"
	"time"
)

func benchMeshRound(b *testing.B, n int) (hopEps, drainEps int) {
	dir := b.TempDir()
	secret := []byte("bench-secret-32-bytes-padded-00000000")
	if err := os.MkdirAll(dir+"/hub-spool", 0o700); err != nil {
		b.Fatal(err)
	}

	hub := NewMesh("hub", secret, func(string, []byte) error { return nil })
	clinic := NewMesh("clinic", secret, func(peer string, raw []byte) error {
		return hub.Intake(raw, dir+"/hub-spool")
	})

	// n hops: clinic -> hub
	t0 := time.Now()
	for i := 0; i < n; i++ {
		e := spoolEntry{TxnID: fmt.Sprintf("txn-%08d", i), Room: "ward",
			Body:  fmt.Sprintf("payload-body-%d", i),
			Sender: "bench", QueuedAt: time.Now().UnixNano()}
		e.Hash = envelopeHash(e.TxnID, e.Room, e.Body)
		if err := clinic.Forward(e, "hub"); err != nil {
			b.Fatalf("hop %d failed: %v", i, err)
		}
	}
	hopEps = int(float64(n) / time.Since(t0).Seconds())

	// hub drains its spool to a sink peer (partition healed)
	sink := NewMesh("sink", secret, func(string, []byte) error { return nil })
	_ = sink
	hub.postFn = func(string, []byte) error { return nil }
	t0 = time.Now()
	fwd, err := hub.Drain(dir+"/hub-spool", "sink")
	if err != nil {
		b.Fatal(err)
	}
	if fwd != n {
		b.Fatalf("drain lost entries: %d of %d", fwd, n)
	}
	drainEps = int(float64(fwd) / time.Since(t0).Seconds())
	return
}

func BenchmarkMesh(b *testing.B) {
	hop, drain := benchMeshRound(b, 10000)
	b.ReportMetric(float64(hop), "hop_eps")
	b.ReportMetric(float64(drain), "drain_eps")
}
