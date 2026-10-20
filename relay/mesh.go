// mesh.go — relay-to-relay mesh forwarding (innovation 10).
//
// When a clinic hotspot's backhaul is down for days (rainy season, fibre
// cut, fuel), its spool is stranded. The mesh lets one relay hand its
// spooled messages to a PEER relay that still has a path upstream — a
// neighbouring clinic, an LGA hub on a different carrier, a visiting
// supervisor's relay on a laptop. Entries hop with an HMAC chain so a
// tampered or replayed hop is quarantined at intake, never forwarded.
//
// Doctrine carried over from the base relay: standard library only,
// ordered replay, dedupe by txn id, fail-loud on tamper.

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
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// MeshEntry extends a spool entry with a hop chain. Each relay that
// forwards the entry appends its own id and re-MACs the running chain,
// so any hop can prove the path the message took — and any edited field
// breaks the chain at the next intake.
type MeshEntry struct {
	spoolEntry
	Hops  []string `json:"hops"`
	Chain string   `json:"chain"` // HMAC over (prev chain | hash | relay id) per hop
}

func chainMAC(secret []byte, prevChain, hash, relayID string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(prevChain))
	mac.Write([]byte{0})
	mac.Write([]byte(hash))
	mac.Write([]byte{0})
	mac.Write([]byte(relayID))
	return hex.EncodeToString(mac.Sum(nil))
}

type Mesh struct {
	id     string
	secret []byte
	seen   map[string]bool // txn dedupe across hops
	seenMu sync.Mutex
	// injectable transport: POST JSON to a peer relay's /mesh/intake.
	postFn func(peer string, body []byte) error
}

func NewMesh(id string, secret []byte, postFn func(string, []byte) error) *Mesh {
	if postFn == nil {
		postFn = func(peer string, body []byte) error {
			resp, err := http.Post(peer+"/mesh/intake", "application/json", bytes.NewReader(body))
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
	return &Mesh{id: id, secret: secret, seen: map[string]bool{}, postFn: postFn}
}

// Forward hands one spooled entry to a peer relay, appending this hop.
func (m *Mesh) Forward(e spoolEntry, peer string) error {
	me := MeshEntry{spoolEntry: e}
	me.Hops = append(me.Hops, m.id)
	me.Chain = chainMAC(m.secret, "", e.Hash, m.id) // genesis hop: empty prev chain
	raw, _ := json.Marshal(me)
	return m.postFn(peer, raw)
}

// Intake receives a meshed entry. Fail-closed: malformed, tampered chain,
// or already-seen txn — all rejected. Valid entries land in the local
// spool for normal ordered replay upstream.
func (m *Mesh) Intake(raw []byte, spoolDir string) error {
	var me MeshEntry
	if err := json.Unmarshal(raw, &me); err != nil {
		return errors.New("malformed mesh entry")
	}
	if me.TxnID == "" || me.Hash == "" || len(me.Hops) == 0 {
		return errors.New("incomplete mesh entry")
	}
	// verify payload integrity first: hash must match content.
	if envelopeHash(me.TxnID, me.Room, me.Body) != me.Hash {
		return errors.New("payload tampered")
	}
	// then verify the hop chain end-to-end (genesis chain starts empty).
	prev := ""
	for _, hop := range me.Hops {
		prev = chainMAC(m.secret, prev, me.Hash, hop)
	}
	if prev != me.Chain {
		return errors.New("chain tampered")
	}
	m.seenMu.Lock()
	if m.seen[me.TxnID] {
		m.seenMu.Unlock()
		return errors.New("duplicate")
	}
	m.seen[me.TxnID] = true
	m.seenMu.Unlock()
	// persist via the base relay spool format so replay() picks it up.
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(me.Hash))
	tag := hex.EncodeToString(mac.Sum(nil))
	out, _ := json.Marshal(me.spoolEntry)
	return os.WriteFile(filepath.Join(spoolDir,
		fmt.Sprintf("%d-%s.%s.json", me.QueuedAt, me.TxnID, tag)), out, 0o600)
}

// Drain forwards every locally spooled entry to a peer, in queue order.
// Entries that fail to forward stay spooled for the next attempt.
func (m *Mesh) Drain(spoolDir, peer string) (forwarded int, err error) {
	files, _ := filepath.Glob(filepath.Join(spoolDir, "*.json"))
	sort.Strings(files)
	for _, f := range files {
		raw, rerr := os.ReadFile(f)
		if rerr != nil {
			continue
		}
		var e spoolEntry
		if json.Unmarshal(raw, &e) != nil || envelopeHash(e.TxnID, e.Room, e.Body) != e.Hash {
			continue // base relay quarantines these; mesh never touches them
		}
		if ferr := m.Forward(e, peer); ferr != nil {
			return forwarded, ferr // ordered: stop at first failure
		}
		os.Remove(f)
		forwarded++
	}
	return forwarded, nil
}
