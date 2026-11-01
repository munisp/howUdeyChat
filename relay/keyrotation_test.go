package main

import (
	"strings"
	"testing"
	"time"
)

func krPeer() FedPeer {
	return FedPeer{ID: "relay-b", URL: "http://b", Secret: []byte("old-secret")}
}

func TestRotationDualSecretGrace(t *testing.T) {
	now := time.Now()
	rp, err := RotateCorridor(krPeer(), []byte("new-secret"), now)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"txn_id":"t1"}`)
	// old secret accepted during grace, and counted
	which, err := rp.AcceptMAC(body, []byte(fedMAC([]byte("old-secret"), body)), now)
	if err != nil || which != "previous(grace)" {
		t.Fatalf("old key in grace: %v %s", err, which)
	}
	if rp.OldKeyUses != 1 {
		t.Fatal("old key use not counted")
	}
	// new secret accepted
	if _, err := rp.AcceptMAC(body, []byte(fedMAC([]byte("new-secret"), body)), now); err != nil {
		t.Fatalf("new key refused: %v", err)
	}
}

func TestRotationGraceExpiryKillsOldKey(t *testing.T) {
	now := time.Now()
	rp, _ := RotateCorridor(krPeer(), []byte("new-secret"), now)
	body := []byte("x")
	old := []byte(fedMAC([]byte("old-secret"), body))
	after := now.Add(RotationWindow + time.Hour)
	_, err := rp.AcceptMAC(body, old, after)
	if err == nil || !strings.Contains(err.Error(), "grace expired") {
		t.Fatalf("old key survived grace expiry: %v", err)
	}
	if _, err := rp.AcceptMAC(body, []byte(fedMAC([]byte("new-secret"), body)), after); err != nil {
		t.Fatal("new key must outlive grace")
	}
}

func TestRotationRequiresDifferentSecret(t *testing.T) {
	if _, err := RotateCorridor(krPeer(), []byte("old-secret"), time.Now()); err == nil {
		t.Fatal("same-secret rotation accepted")
	}
	if _, err := RotateCorridor(krPeer(), nil, time.Now()); err == nil {
		t.Fatal("empty new secret accepted")
	}
}

func TestCompleteCutoverRefusesOldImmediately(t *testing.T) {
	rp, _ := RotateCorridor(krPeer(), []byte("new-secret"), time.Now())
	rp.Complete()
	body := []byte("x")
	if _, err := rp.AcceptMAC(body, []byte(fedMAC([]byte("old-secret"), body)), time.Now()); err == nil {
		t.Fatal("old key accepted after complete cutover")
	}
}

func TestStatusSurfacesPeerOnOldKey(t *testing.T) {
	now := time.Now()
	rp, _ := RotateCorridor(krPeer(), []byte("new-secret"), now)
	body := []byte("x")
	rp.AcceptMAC(body, []byte(fedMAC([]byte("old-secret"), body)), now)
	st := rp.Status(now)
	if st["state"] != "peer-still-on-old-key—contact-them" {
		t.Fatalf("bad state: %v", st["state"])
	}
	rp.Complete()
	if rp.Status(now)["state"] != "stable" {
		t.Fatal("should be stable after completion")
	}
}
