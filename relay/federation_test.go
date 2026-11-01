package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func fedPair(t *testing.T) (*Federation, *Federation, *httptest.Server) {
	t.Helper()
	secretAB := []byte("corridor-secret-a-b")
	b, err := NewFederation("relay-b", nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(b.ReceiveHTTP))
	a, err := NewFederation("relay-a", []FedPeer{
		{ID: "relay-b", URL: srv.URL, Secret: secretAB},
	})
	if err != nil {
		t.Fatal(err)
	}
	b.peers["relay-a"] = FedPeer{ID: "relay-a", URL: "", Secret: secretAB}
	return a, b, srv
}

func fedTestEntry(txn string) FedEntry {
	return FedEntry{spoolEntry: spoolEntry{
		TxnID: txn, Room: "room-1", Body: "hello", Sender: "u@a", Hash: "h"}}
}

func TestFederationHappyPath(t *testing.T) {
	a, b, srv := fedPair(t)
	defer srv.Close()
	out := a.Forward(fedTestEntry("txn-1"))
	if err := out["relay-b"]; err != nil {
		t.Fatalf("forward failed: %v", err)
	}
	b.mu.Lock()
	seen := b.seen["txn-1"]
	b.mu.Unlock()
	if !seen {
		t.Fatal("relay-b did not record the federated entry")
	}
}

func TestFederationBadMACQuarantined(t *testing.T) {
	_, b, _ := fedPair(t)
	body, _ := json.Marshal(fedTestEntry("txn-2"))
	_, err := b.Receive("relay-a", body, []byte("deadbeef"))
	if err == nil || !strings.Contains(err.Error(), "MAC") {
		t.Fatalf("expected MAC refusal, got %v", err)
	}
	if len(b.Quarantine()) != 1 || !strings.Contains(b.Quarantine()[0], "bad-mac") {
		t.Fatalf("quarantine missing: %v", b.Quarantine())
	}
}

func TestFederationUnknownPeerRefused(t *testing.T) {
	_, b, _ := fedPair(t)
	body, _ := json.Marshal(fedTestEntry("txn-3"))
	if _, err := b.Receive("ghost-relay", body, []byte("x")); err == nil {
		t.Fatal("unknown peer accepted")
	}
}

func TestFederationLoopRefused(t *testing.T) {
	_, b, _ := fedPair(t)
	e := fedTestEntry("txn-4")
	e.OriginPath = []string{"relay-a", "relay-b"} // already crossed b
	e.FromPeer = "relay-a"
	body, _ := json.Marshal(e)
	mac := fedMAC(b.peers["relay-a"].Secret, body)
	if _, err := b.Receive("relay-a", body, []byte(mac)); err == nil ||
		!strings.Contains(err.Error(), "loop") {
		t.Fatalf("loop not refused: %v", err)
	}
}

func TestFederationSenderMismatchRefused(t *testing.T) {
	_, b, _ := fedPair(t)
	e := fedTestEntry("txn-5")
	e.FromPeer = "someone-else"
	body, _ := json.Marshal(e)
	mac := fedMAC(b.peers["relay-a"].Secret, body)
	if _, err := b.Receive("relay-a", body, []byte(mac)); err == nil {
		t.Fatal("sender mismatch accepted")
	}
}

func TestFederationDedupe(t *testing.T) {
	a, b, srv := fedPair(t)
	defer srv.Close()
	e := fedTestEntry("txn-6")
	a.Forward(e)
	a.Forward(e) // replay
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.seen["txn-6"] {
		t.Fatal("entry not seen")
	}
	// duplicate intake returns errDuplicate internally; HTTP returns 200
}

func TestFederationConfigGuards(t *testing.T) {
	if _, err := NewFederation("", nil); err == nil {
		t.Fatal("empty local id accepted")
	}
	if _, err := NewFederation("a", []FedPeer{{ID: "a", URL: "u", Secret: []byte("s")}}); err == nil {
		t.Fatal("self-federation accepted")
	}
	if _, err := NewFederation("a", []FedPeer{{ID: "b", URL: "u"}}); err == nil {
		t.Fatal("peer without secret accepted")
	}
}
