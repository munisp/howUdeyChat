// keyrotation.go — corridor key rotation for federation peers.
//
// Preshared corridor secrets must rotate, but a hard cutover on a
// link that is down for days (rainy season, fibre cut) strands every
// in-flight message. So rotation is dual-secret: during the grace
// window the corridor accepts MACs from BOTH the retiring and the
// incoming secret, sends with the NEW one, and refuses the old one
// once the window closes. Every accepted-old-secret intake is counted
// and surfaced — a corridor still on the old key near the deadline is
// an ops finding, not a surprise outage.

package main

import (
	"errors"
	"fmt"
	"time"
)

// RotationWindow is how long both secrets are accepted during rotation.
const RotationWindow = 7 * 24 * time.Hour

// RotatingPeer wraps a FedPeer with rotation state.
type RotatingPeer struct {
	Current   FedPeer
	Previous  *FedPeer  // retiring secret, accepted during grace
	RotateEnd time.Time // after this, Previous is refused
	OldKeyUses int      // intakes accepted via the retiring secret
}

// NewRotation starts a rotation: the peer's current secret becomes
// previous; newSecret becomes current.
func RotateCorridor(peer FedPeer, newSecret []byte, now time.Time) (*RotatingPeer, error) {
	if len(newSecret) == 0 {
		return nil, errors.New("new secret required")
	}
	if string(newSecret) == string(peer.Secret) {
		return nil, errors.New("rotation requires a DIFFERENT secret")
	}
	prev := peer
	rp := &RotatingPeer{
		Current: FedPeer{ID: peer.ID, URL: peer.URL, Secret: newSecret},
		Previous: &prev,
		RotateEnd: now.Add(RotationWindow),
	}
	return rp, nil
}

// AcceptMAC validates an inbound MAC against the corridor's secrets,
// honouring the grace window. Returns which secret matched.
func (rp *RotatingPeer) AcceptMAC(body, macHex []byte, now time.Time) (string, error) {
	if hmacEqual(fedMAC(rp.Current.Secret, body), string(macHex)) {
		return "current", nil
	}
	if rp.Previous != nil {
		if now.After(rp.RotateEnd) {
			return "", fmt.Errorf("rotation grace expired for %s — the old secret is dead, refetch the runbook", rp.Current.ID)
		}
		if hmacEqual(fedMAC(rp.Previous.Secret, body), string(macHex)) {
			rp.OldKeyUses++
			return "previous(grace)", nil
		}
	}
	return "", errors.New("MAC mismatch — quarantined")
}

// SendSecret is always the current one.
func (rp *RotatingPeer) SendSecret() []byte { return rp.Current.Secret }

// Complete ends the grace window early — e.g. after the peer confirms
// cutover. After this the old secret is refused.
func (rp *RotatingPeer) Complete() {
	rp.Previous = nil
}

// Status reports rotation state for the ops dashboard.
func (rp *RotatingPeer) Status(now time.Time) map[string]any {
	st := map[string]any{
		"peer":           rp.Current.ID,
		"in_rotation":    rp.Previous != nil,
		"old_key_intakes": rp.OldKeyUses,
	}
	if rp.Previous != nil {
		st["grace_remaining_hours"] = int(time.Until(rp.RotateEnd).Hours())
		if now.After(rp.RotateEnd) {
			st["state"] = "grace-expired-old-key-dead"
		} else if rp.OldKeyUses > 0 {
			st["state"] = "peer-still-on-old-key—contact-them"
		} else {
			st["state"] = "rotating"
		}
	} else {
		st["state"] = "stable"
	}
	return st
}

func hmacEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}
