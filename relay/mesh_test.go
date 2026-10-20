package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func meshSpool(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func TestMeshForwardIntakeRoundTrip(t *testing.T) {
	secret := []byte("mesh-test-secret")
	var posted []byte
	m1 := NewMesh("relay-wuse", secret, func(peer string, body []byte) error {
		posted = body
		return nil
	})
	m2 := NewMesh("relay-garki", secret, nil)

	e := spoolEntry{TxnID: "txn-1", Room: "!ward:hs.ng", Body: "hello", Sender: "@amina:hs.ng", QueuedAt: 1}
	e.Hash = envelopeHash(e.TxnID, e.Room, e.Body)
	if err := m1.Forward(e, "http://garki"); err != nil {
		t.Fatalf("forward: %v", err)
	}
	dir := meshSpool(t)
	if err := m2.Intake(posted, dir); err != nil {
		t.Fatalf("intake: %v", err)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	if len(files) != 1 {
		t.Fatalf("expected 1 spooled file, got %d", len(files))
	}
	raw, _ := os.ReadFile(files[0])
	var back spoolEntry
	json.Unmarshal(raw, &back)
	if back.Body != "hello" || back.TxnID != "txn-1" {
		t.Fatalf("round trip lost content: %+v", back)
	}
}

func TestMeshIntakeRejectsTamperedPayload(t *testing.T) {
	secret := []byte("mesh-test-secret")
	var posted []byte
	m1 := NewMesh("relay-a", secret, func(_ string, b []byte) error { posted = b; return nil })
	e := spoolEntry{TxnID: "txn-2", Room: "!r", Body: "original", QueuedAt: 1}
	e.Hash = envelopeHash(e.TxnID, e.Room, e.Body)
	m1.Forward(e, "http://b")

	var me MeshEntry
	json.Unmarshal(posted, &me)
	me.Body = "forged" // attacker edits the message in transit
	forged, _ := json.Marshal(me)

	m2 := NewMesh("relay-b", secret, nil)
	if err := m2.Intake(forged, meshSpool(t)); err == nil || err.Error() != "payload tampered" {
		t.Fatalf("tampered payload must be rejected, got %v", err)
	}
}

func TestMeshIntakeRejectsTamperedChain(t *testing.T) {
	secret := []byte("mesh-test-secret")
	var posted []byte
	m1 := NewMesh("relay-a", secret, func(_ string, b []byte) error { posted = b; return nil })
	e := spoolEntry{TxnID: "txn-3", Room: "!r", Body: "x", QueuedAt: 1}
	e.Hash = envelopeHash(e.TxnID, e.Room, e.Body)
	m1.Forward(e, "http://b")

	var me MeshEntry
	json.Unmarshal(posted, &me)
	me.Hops = append(me.Hops, "rogue-relay") // attacker claims a path it never took
	forged, _ := json.Marshal(me)

	m2 := NewMesh("relay-b", secret, nil)
	if err := m2.Intake(forged, meshSpool(t)); err == nil || err.Error() != "chain tampered" {
		t.Fatalf("tampered chain must be rejected, got %v", err)
	}
}

func TestMeshIntakeDedupes(t *testing.T) {
	secret := []byte("k")
	var posted []byte
	m1 := NewMesh("a", secret, func(_ string, b []byte) error { posted = b; return nil })
	e := spoolEntry{TxnID: "txn-4", Room: "!r", Body: "y", QueuedAt: 1}
	e.Hash = envelopeHash(e.TxnID, e.Room, e.Body)
	m1.Forward(e, "http://b")

	dir := meshSpool(t)
	m2 := NewMesh("b", secret, nil)
	if err := m2.Intake(posted, dir); err != nil {
		t.Fatal(err)
	}
	if err := m2.Intake(posted, dir); err == nil || err.Error() != "duplicate" {
		t.Fatalf("replay of same txn must be rejected, got %v", err)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	if len(files) != 1 {
		t.Fatalf("duplicate must not spool twice, got %d files", len(files))
	}
}

func TestMeshDrainOrderedAndAtomic(t *testing.T) {
	secret := []byte("k")
	dir := meshSpool(t)
	r := &Relay{spoolDir: dir, secret: secret}
	r.spool(spoolEntry{TxnID: "a", Room: "!r", Body: "1", QueuedAt: 1})
	r.spool(spoolEntry{TxnID: "b", Room: "!r", Body: "2", QueuedAt: 2})
	r.spool(spoolEntry{TxnID: "c", Room: "!r", Body: "3", QueuedAt: 3})

	var order []string
	mesh := NewMesh("relay-a", secret, func(_ string, body []byte) error {
		var me MeshEntry
		json.Unmarshal(body, &me)
		order = append(order, me.TxnID)
		return nil
	})
	n, err := mesh.Drain(dir, "http://peer")
	if err != nil || n != 3 {
		t.Fatalf("drain: n=%d err=%v", n, err)
	}
	if order[0] != "a" || order[1] != "b" || order[2] != "c" {
		t.Fatalf("out of order: %v", order)
	}
	left, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	if len(left) != 0 {
		t.Fatalf("forwarded entries must leave the spool, %d left", len(left))
	}
}
