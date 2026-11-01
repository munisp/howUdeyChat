// federation.go — cross-organization relay federation.
//
// The mesh (mesh.go) moves spooled entries between relays of ONE
// deployment over a shared secret. Federation is the harder case: two
// SOVEREIGN deployments — a ministry's relay network and a cooperative
// federation's — exchanging entries without sharing a master secret and
// without either side being able to enumerate or spoof the other.
//
// Design:
// - Bilateral pairing: each peer relationship has its OWN preshared
//   secret (provisioned out of band). Compromise of one pair exposes
//   no other corridor.
// - Origin path: every federated entry carries the list of federation
//   relay ids it has crossed; a relay refuses an entry whose path
//   already contains its own federation id (loop prevention) and
//   never forwards an entry back along its incoming corridor.
// - Fail-closed intake: unknown peer, bad MAC, malformed entry, or a
//   loop = quarantine with the reason, never forward.
// - Federation is not trust: the receiving deployment still applies
//   its own intake rules; federation only guarantees the corridor.

package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// FedPeer is one bilateral corridor to another deployment's relay.
type FedPeer struct {
	ID     string // the peer's federation id, e.g. "coop-fed-kano"
	URL    string // its /federation/receive endpoint
	Secret []byte // bilateral preshared key — unique per corridor
}

// FedEntry is a spool entry wrapped for federation transit.
type FedEntry struct {
	spoolEntry
	OriginPath []string `json:"origin_path"` // federation ids crossed, in order
	FromPeer   string   `json:"from_peer"`   // immediate sender's federation id
}

func fedMAC(secret, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// Federation manages corridors and loop-safe forwarding.
type Federation struct {
	localID string
	peers   map[string]FedPeer // by federation id
	seen    map[string]bool    // txn dedupe across all corridors
	mu      sync.Mutex
	client  *http.Client
	quarantine []string // rejected entry summaries, fail-loud
}

func NewFederation(localID string, peers []FedPeer) (*Federation, error) {
	if localID == "" {
		return nil, errors.New("federation id required")
	}
	f := &Federation{
		localID: localID,
		peers:   map[string]FedPeer{},
		seen:    map[string]bool{},
		client:  &http.Client{Timeout: 10 * time.Second},
	}
	for _, p := range peers {
		if p.ID == "" || p.URL == "" || len(p.Secret) == 0 {
			return nil, fmt.Errorf("peer %q: id, url and secret all required", p.ID)
		}
		if p.ID == localID {
			return nil, errors.New("a relay cannot federate with itself")
		}
		if _, dup := f.peers[p.ID]; dup {
			return nil, fmt.Errorf("duplicate peer: %s", p.ID)
		}
		f.peers[p.ID] = p
	}
	return f, nil
}

// Receive validates and accepts an inbound federated entry. Returns
// the entry for local intake, or an error naming the refusal.
func (f *Federation) Receive(peerID string, body, macHex []byte) (*FedEntry, error) {
	peer, ok := f.peers[peerID]
	if !ok {
		f.refuse(peerID, "unknown-peer")
		return nil, fmt.Errorf("unknown federation peer: %s", peerID)
	}
	if !hmac.Equal([]byte(fedMAC(peer.Secret, body)), []byte(strings0(macHex))) {
		f.refuse(peerID, "bad-mac")
		return nil, errors.New("federation MAC mismatch — quarantined")
	}
	var e FedEntry
	if err := json.Unmarshal(body, &e); err != nil {
		f.refuse(peerID, "malformed")
		return nil, fmt.Errorf("malformed federated entry: %w", err)
	}
	if e.FromPeer != peerID {
		f.refuse(peerID, "sender-mismatch")
		return nil, errors.New("from_peer does not match the authenticated corridor")
	}
	for _, id := range e.OriginPath {
		if id == f.localID {
			f.refuse(peerID, "loop")
			return nil, fmt.Errorf("entry %s already crossed %s — loop refused",
				e.TxnID, f.localID)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.seen[e.TxnID] {
		return nil, errDuplicate
	}
	f.seen[e.TxnID] = true
	return &e, nil
}

var errDuplicate = errors.New("duplicate txn")

// Forward sends an entry to every corridor except ones already in its
// origin path. Returns per-peer outcomes; a failed corridor is reported,
// not silent.
func (f *Federation) Forward(e FedEntry) map[string]error {
	out := map[string]error{}
	e.FromPeer = f.localID
	e.OriginPath = append(append([]string{}, e.OriginPath...), f.localID)
	body, err := json.Marshal(e)
	if err != nil {
		out["_marshal"] = err
		return out
	}
	for id, peer := range f.peers {
		if contains(e.OriginPath[:len(e.OriginPath)-1], id) {
			continue // never back along its corridor
		}
		if id == f.localID {
			continue
		}
		out[id] = f.sendOne(peer, body)
	}
	return out
}

func (f *Federation) sendOne(peer FedPeer, body []byte) error {
	req, err := http.NewRequest("POST", peer.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Federation-Peer", f.localID)
	req.Header.Set("X-Federation-MAC", fedMAC(peer.Secret, body))
	resp, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("peer %s refused: %d", peer.ID, resp.StatusCode)
	}
	return nil
}

// ReceiveHTTP is the /federation/receive handler.
func (f *Federation) ReceiveHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "read", 400)
		return
	}
	peerID := r.Header.Get("X-Federation-Peer")
	mac := r.Header.Get("X-Federation-MAC")
	if _, err := f.Receive(peerID, body, []byte(mac)); err != nil {
		if errors.Is(err, errDuplicate) {
			w.WriteHeader(200) // duplicates are fine, idempotent
			return
		}
		http.Error(w, err.Error(), 403)
		return
	}
	w.WriteHeader(200)
}

func (f *Federation) refuse(peerID, reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.quarantine = append(f.quarantine, fmt.Sprintf("%s:%s", peerID, reason))
}

// Quarantine exposes the refusal log — silent drops are not allowed.
func (f *Federation) Quarantine() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.quarantine...)
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

func strings0(b []byte) string { return string(b) }
