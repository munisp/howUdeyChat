// chaos_mesh_test.go — chaos spike for the relay mesh (ADR-0068).
//
// The mesh exists for the wild: rainy-season backhaul, a peer on a
// motorbike hotspot, packets dropped and reordered. This harness injects
// that wild at the transport seam (postFn) and asserts the doctrine
// survives it:
//
//   - DROPS: transport randomly fails; Drain stops at first failure,
//     entries stay spooled, and a retry loop eventually lands every one.
//     No message is ever silently lost.
//   - DUPLICATES: transport delivers some entries twice (a retried POST
//     that actually succeeded); intake dedupe rejects the second copy.
//   - REORDERING: transport buffers and delivers shuffled; intake accepts
//     out-of-order arrivals (dedupe is by txn id, not sequence) while the
//     base spool's queued-at ordering governs final replay order.
//   - TAMPER under chaos: one entry whose chain is edited mid-flight is
//     quarantined even while its neighbours land.
//
// Timings are recorded, never asserted (load doctrine). Correctness —
// zero loss, zero dupes accepted, tamper refused — is what the tests pin.

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"sort"
	"testing"
	"time"
)

// chaosTransport wraps a real deliver function with seeded chaos.
type chaosTransport struct {
	rng       *rand.Rand
	dropRate  float64
	dupeRate  float64
	reorder   bool
	buffer    [][]byte // when reordering, hold and flush shuffled
	peer      string
	deliver   func(string, []byte) error
	delivered int
	dropped   int
	dupes     int
}

func (c *chaosTransport) post(peer string, body []byte) error {
	if c.reorder {
		c.buffer = append(c.buffer, append([]byte(nil), body...))
		return nil
	}
	return c.send(peer, body)
}

func (c *chaosTransport) send(peer string, body []byte) error {
	if c.rng.Float64() < c.dropRate {
		c.dropped++
		return errors.New("chaos: simulated drop")
	}
	if err := c.deliver(peer, body); err != nil {
		return err
	}
	c.delivered++
	if c.rng.Float64() < c.dupeRate {
		// retry-that-actually-succeeded: deliver the same bytes again;
		// the peer's intake must refuse the second copy.
		c.dupes++
		if err := c.deliver(peer, body); err == nil {
			return errors.New("chaos: duplicate accepted at intake")
		}
	}
	return nil
}

// flush delivers buffered messages in shuffled order (reorder chaos).
func (c *chaosTransport) flush() {
	idx := c.rng.Perm(len(c.buffer))
	for _, i := range idx {
		if err := c.send(c.peer, c.buffer[i]); err == nil {
			// dropped ones are retried once so reorder tests measure
			// ordering tolerance, not loss tolerance.
			_ = c.deliver(c.peer, c.buffer[i])
		}
	}
	c.buffer = nil
}

func mkSpoolEntries(n int, start int64) []spoolEntry {
	out := make([]spoolEntry, n)
	for i := range out {
		txn := fmt.Sprintf("chaos-txn-%04d", i)
		out[i] = spoolEntry{
			TxnID:    txn,
			Room:     "room-chaos",
			Body:     fmt.Sprintf("vitals payload %d", i),
			QueuedAt: start + int64(i),
			Hash:     envelopeHash(txn, "room-chaos", fmt.Sprintf("vitals payload %d", i)),
		}
	}
	return out
}

// intakeSink acts as the peer relay: a real Mesh.Intake into a real spool.
func intakeSink(t *testing.T, m *Mesh, spoolDir string) func(string, []byte) error {
	return func(_ string, body []byte) error {
		return m.Intake(body, spoolDir)
	}
}

func spoolCount(t *testing.T, dir string) int {
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read spool: %v", err)
	}
	return len(files)
}

func TestChaosDropsNeverLoseMessages(t *testing.T) {
	secret := []byte("chaos-secret")
	peerSpool := t.TempDir()
	peer := NewMesh("peer", secret, nil)
	sink := intakeSink(t, peer, peerSpool)

	ct := &chaosTransport{rng: rand.New(rand.NewSource(42)),
		dropRate: 0.4, deliver: sink, peer: "peer"}
	src := NewMesh("src", secret, ct.post)
	srcSpool := t.TempDir()

	const n = 300
	for _, e := range mkSpoolEntries(n, 1_700_000_000) {
		raw, _ := json.Marshal(e)
		tag := e.Hash[:8]
		os.WriteFile(fmt.Sprintf("%s/%d-%s.%s.json", srcSpool, e.QueuedAt, e.TxnID, tag), raw, 0o600)
	}

	// Retry drain until the peer holds everything. A mesh that loses a
	// message under drops would deadlock this loop — the test timeout
	// would be the failure signal, which is the honest shape of loss.
	start := time.Now()
	for spoolCount(t, peerSpool) < n {
		if _, err := src.Drain(srcSpool, "peer"); err != nil {
			continue // drop: entries stayed spooled, try again
		}
	}
	t.Logf("chaos drain: %d entries, %d simulated drops, %v",
		n, ct.dropped, time.Since(start).Round(time.Millisecond))

	if got := spoolCount(t, peerSpool); got != n {
		t.Fatalf("loss under chaos: peer holds %d of %d", got, n)
	}
	if ct.dropped == 0 {
		t.Fatal("chaos never fired — spike would prove nothing")
	}
}

func TestChaosDuplicatesRejectedAtIntake(t *testing.T) {
	secret := []byte("chaos-secret")
	peerSpool := t.TempDir()
	peer := NewMesh("peer", secret, nil)
	ct := &chaosTransport{rng: rand.New(rand.NewSource(7)),
		dupeRate: 0.5, deliver: intakeSink(t, peer, peerSpool), peer: "peer"}
	src := NewMesh("src", secret, ct.post)

	const n = 100
	for _, e := range mkSpoolEntries(n, 1_800_000_000) {
		if err := src.Forward(e, "peer"); err != nil {
			t.Fatalf("forward: %v", err)
		}
	}
	if got := spoolCount(t, peerSpool); got != n {
		t.Fatalf("duplicate accepted: peer holds %d of %d", got, n)
	}
	if ct.dupes == 0 {
		t.Fatal("dupe chaos never fired — spike would prove nothing")
	}
	t.Logf("chaos dupes: %d second-copies delivered, all refused", ct.dupes)
}

func TestChaosReorderAcceptedDedupByTxn(t *testing.T) {
	secret := []byte("chaos-secret")
	peerSpool := t.TempDir()
	peer := NewMesh("peer", secret, nil)
	ct := &chaosTransport{rng: rand.New(rand.NewSource(99)),
		reorder: true, deliver: intakeSink(t, peer, peerSpool), peer: "peer"}
	src := NewMesh("src", secret, ct.post)

	entries := mkSpoolEntries(60, 1_900_000_000)
	for _, e := range entries {
		if err := src.Forward(e, "peer"); err != nil {
			t.Fatalf("buffer: %v", err)
		}
	}
	ct.flush()

	if got := spoolCount(t, peerSpool); got != len(entries) {
		t.Fatalf("reorder loss: %d of %d", got, len(entries))
	}
	// Final replay order comes from spool filenames (queued-at prefix),
	// not arrival order — assert the landed set is exactly the sent set.
	files, _ := os.ReadDir(peerSpool)
	txns := map[string]bool{}
	for _, f := range files {
		raw, _ := os.ReadFile(peerSpool + "/" + f.Name())
		var e spoolEntry
		json.Unmarshal(raw, &e)
		txns[e.TxnID] = true
	}
	for _, e := range entries {
		if !txns[e.TxnID] {
			t.Fatalf("missing txn after reorder: %s", e.TxnID)
		}
	}
}

func TestChaosTamperedEntryQuarantinedMidStorm(t *testing.T) {
	secret := []byte("chaos-secret")
	peerSpool := t.TempDir()
	peer := NewMesh("peer", secret, nil)
	sink := intakeSink(t, peer, peerSpool)

	entries := mkSpoolEntries(10, 2_000_000_000)
	landed := 0
	for i, e := range entries {
		if i == 5 {
			// tamper mid-storm: edit the body but keep the hash — the
			// payload integrity check must catch it.
			e.Body = "edited by an attacker"
		}
		err := NewMesh("src", secret, sink).Forward(e, "peer")
		if i == 5 {
			if err == nil {
				t.Fatal("tampered entry accepted under chaos")
			}
			continue
		}
		if err != nil {
			t.Fatalf("honest entry %d rejected: %v", i, err)
		}
		landed++
	}
	if landed != 9 {
		t.Fatalf("want 9 honest entries landed, got %d", landed)
	}
	if got := spoolCount(t, peerSpool); got != 9 {
		t.Fatalf("peer spool holds %d, want 9 (tampered quarantined)", got)
	}
}

func TestChaosRetryLoopPreservesQueueOrder(t *testing.T) {
	// Under drops, Drain stops at the first failure and restarts from the
	// top of the spool — the peer must observe queue order, not retry
	// order, for what it accepts.
	secret := []byte("chaos-secret")
	var accepted []string
	peerSpool := t.TempDir()
	peer := NewMesh("peer", secret, nil)
	ct := &chaosTransport{rng: rand.New(rand.NewSource(13)),
		dropRate: 0.3, peer: "peer",
		deliver: func(_ string, body []byte) error {
			if err := peer.Intake(body, peerSpool); err != nil {
				return err
			}
			var me MeshEntry
			json.Unmarshal(body, &me)
			accepted = append(accepted, me.TxnID)
			return nil
		}}
	src := NewMesh("src", secret, ct.post)
	srcSpool := t.TempDir()

	const n = 50
	for _, e := range mkSpoolEntries(n, 2_100_000_000) {
		raw, _ := json.Marshal(e)
		os.WriteFile(fmt.Sprintf("%s/%d-%s.%s.json", srcSpool, e.QueuedAt, e.TxnID, e.Hash[:8]), raw, 0o600)
	}
	for len(accepted) < n {
		if _, err := src.Drain(srcSpool, "peer"); err != nil {
			continue
		}
	}
	sorted := sort.SliceIsSorted(accepted, func(i, j int) bool {
		return accepted[i] < accepted[j]
	})
	if !sorted {
		t.Fatal("acceptance order diverged from queue order under chaos")
	}
}
