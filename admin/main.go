// admin — howUdeyChat provisioning & management service (Go, std lib only).
//
// The registration-desk brain: turns "patient registered at Kawo PHC" into
// "patient has a working howUdeyChat account in their hand" — and manages
// the lifecycle after (revoke lost phones, audit everything).
//
// Surfaces:
//   POST /v1/provision   {patient_id, phone, display_name} -> {username, setup_code, card}
//   POST /v1/activate    {username, setup_code, patient_id, phone, pin} -> 200 | 404
//   GET  /v1/accounts    -> audit list (management token)
//   POST /v1/revoke      {username, reason} -> deactivate device/user
//   GET  /healthz
//
// Doctrine: fail-closed identity (patient ID + phone pair validated against
// the OpenHealth registry, 404-indistinguishable), setup codes stored as
// hashes, spool-and-replay when the homeserver is down, append-only audit.
package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Listen        string
	Homeserver    string // Synapse base URL
	SharedSecret  string // Synapse registration shared secret
	RegistryURL   string // OpenHealth OS registry-service
	MgmtToken     string // bearer for management endpoints
	DataDir       string // accounts + audit + spool
	UsernameRealm string // homeserver domain, e.g. "clinic.ng"
}

type Account struct {
	Username    string `json:"username"`
	PatientID   string `json:"patient_id"`
	Phone       string `json:"phone"`
	DisplayName string `json:"display_name"`
	CodeHash    string `json:"code_hash"` // sha256 of setup code — never the code
	Activated   bool   `json:"activated"`
	Revoked     bool   `json:"revoked"`
	CreatedAt   int64  `json:"created_at"`
	ActivatedAt int64  `json:"activated_at,omitempty"`
	RevokedAt   int64  `json:"revoked_at,omitempty"`
	RevokeWhy   string `json:"revoke_reason,omitempty"`
}

type Service struct {
	cfg     Config
	client  *http.Client
	mu      sync.Mutex
	accounts map[string]*Account // username -> account
}

func main() {
	cfg := Config{
		Listen:        envOr("LISTEN", ":8100"),
		Homeserver:    envOr("HOMESERVER", "http://127.0.0.1:8008"),
		SharedSecret:  envOr("SYNAPSE_SHARED_SECRET", "dev-shared-secret"),
		RegistryURL:   envOr("REGISTRY_URL", "http://127.0.0.1:8081"),
		MgmtToken:     envOr("MGMT_TOKEN", "dev-mgmt-token"),
		DataDir:       envOr("DATA_DIR", "/var/lib/howudeychat-admin"),
		UsernameRealm: envOr("USERNAME_REALM", "clinic.ng"),
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		log.Fatal(err)
	}
	s := &Service{cfg: cfg, client: &http.Client{Timeout: 10 * time.Second}, accounts: map[string]*Account{}}
	s.load()
	go s.spoolWorker()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"ok":true}`) })
	mux.HandleFunc("POST /v1/provision", s.auth(s.handleProvision))
	mux.HandleFunc("POST /v1/activate", s.handleActivate) // patient-facing: no mgmt token, code IS the credential
	mux.HandleFunc("GET /v1/accounts", s.auth(s.handleAccounts))
	mux.HandleFunc("POST /v1/revoke", s.auth(s.handleRevoke))
	log.Printf("howUdeyChat admin on %s (homeserver %s)", cfg.Listen, cfg.Homeserver)
	log.Fatal(http.ListenAndServe(cfg.Listen, mux))
}

func (s *Service) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if subtleEq(r.Header.Get("Authorization"), "Bearer "+s.cfg.MgmtToken) {
			next(w, r)
			return
		}
		http.Error(w, "unauthorized", 401)
	}
}

// --- provisioning ------------------------------------------------------------

func (s *Service) handleProvision(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PatientID   string `json:"patient_id"`
		Phone       string `json:"phone"`
		DisplayName string `json:"display_name"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil || req.PatientID == "" || req.Phone == "" {
		http.Error(w, "patient_id and phone required", 400)
		return
	}
	// patient must exist in OpenHealth OS — no phantom chat accounts
	if !s.patientExists(req.PatientID, req.Phone) {
		http.Error(w, "unknown patient", 404)
		return
	}
	username := usernameFor(req.PatientID)
	code := setupCode()

	s.mu.Lock()
	acct := &Account{
		Username: username, PatientID: req.PatientID, Phone: normPhone(req.Phone),
		DisplayName: req.DisplayName, CodeHash: hashCode(code), CreatedAt: time.Now().Unix(),
	}
	s.accounts[username] = acct
	s.mu.Unlock()
	s.persist(acct)

	// create the Matrix account; if the homeserver is down, spool + replay
	if err := s.createMatrixUser(username, code); err != nil {
		s.spool(username, code)
	}
	s.audit("provision", username, req.PatientID)

	writeJSON(w, 201, map[string]any{
		"username":   username,
		"setup_code": code,
		"card": map[string]string{
			"install": "https://chat." + s.cfg.UsernameRealm,
			"login":   username + ":" + s.cfg.UsernameRealm,
			"code":    code,
		},
	})
}

// activation — patient-facing. The code is the credential; patient ID +
// phone must match the registry pair. Everything wrong gets the same 404.
func (s *Service) handleActivate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username  string `json:"username"`
		SetupCode string `json:"setup_code"`
		PatientID string `json:"patient_id"`
		Phone     string `json:"phone"`
		PIN       string `json:"pin"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		http.Error(w, "bad request", 400)
		return
	}
	s.mu.Lock()
	acct, found := s.accounts[req.Username]
	s.mu.Unlock()
	fail := func() { http.Error(w, "cannot activate", 404) }

	if !found || acct.Revoked || acct.Activated {
		fail()
		return
	}
	if subtleCompare(hashCode(req.SetupCode), acct.CodeHash) != 1 {
		fail()
		return
	}
	// fail-closed binding: the pair must match what registration recorded
	if acct.PatientID != req.PatientID || acct.Phone != normPhone(req.Phone) {
		fail()
		return
	}
	if len(req.PIN) < 4 {
		http.Error(w, "pin too short", 400)
		return
	}
	if err := s.setMatrixPassword(req.Username, req.PIN); err != nil {
		http.Error(w, "homeserver unavailable, retry shortly", 503)
		return
	}
	s.mu.Lock()
	acct.Activated = true
	acct.ActivatedAt = time.Now().Unix()
	acct.CodeHash = "" // burned — one-time by construction
	s.mu.Unlock()
	s.persist(acct)
	s.audit("activate", req.Username, req.PatientID)
	writeJSON(w, 200, map[string]any{"status": "active", "user_id": "@" + req.Username + ":" + s.cfg.UsernameRealm})
}

func (s *Service) handleAccounts(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	list := make([]*Account, 0, len(s.accounts))
	for _, a := range s.accounts {
		list = append(list, a)
	}
	s.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt > list[j].CreatedAt })
	writeJSON(w, 200, map[string]any{"accounts": list, "count": len(list)})
}

func (s *Service) handleRevoke(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Reason   string `json:"reason"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		http.Error(w, "bad request", 400)
		return
	}
	s.mu.Lock()
	acct, found := s.accounts[req.Username]
	s.mu.Unlock()
	if !found {
		http.Error(w, "unknown account", 404)
		return
	}
	if err := s.deactivateMatrixUser(req.Username); err != nil {
		s.spoolRevoke(req.Username) // homeserver down: revoke replays on recovery
	}
	s.mu.Lock()
	acct.Revoked = true
	acct.RevokedAt = time.Now().Unix()
	acct.RevokeWhy = req.Reason
	s.mu.Unlock()
	s.persist(acct)
	s.audit("revoke", req.Username, req.Reason)
	writeJSON(w, 200, map[string]string{"status": "revoked"})
}

// --- homeserver (Synapse shared-secret admin registration) -------------------

func (s *Service) createMatrixUser(username, password string) error {
	// GET /_synapse/admin/v1/register -> nonce, then HMAC-signed POST
	nonceRes, err := s.client.Get(s.cfg.Homeserver + "/_synapse/admin/v1/register")
	if err != nil {
		return err
	}
	defer nonceRes.Body.Close()
	var nonce struct {
		Nonce string `json:"nonce"`
	}
	if json.NewDecoder(nonceRes.Body).Decode(&nonce) != nil || nonce.Nonce == "" {
		return fmt.Errorf("no nonce")
	}
	mac := hmac.New(sha1.New, []byte(s.cfg.SharedSecret))
	for _, p := range []string{nonce.Nonce, username, password, "notadmin"} {
		mac.Write([]byte(p))
		mac.Write([]byte{0})
	}
	body, _ := json.Marshal(map[string]any{
		"nonce": nonce.Nonce, "username": username, "password": password,
		"admin": false, "mac": hex.EncodeToString(mac.Sum(nil)),
	})
	res, err := s.client.Post(s.cfg.Homeserver+"/_synapse/admin/v1/register",
		"application/json", strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		b, _ := io.ReadAll(res.Body)
		return fmt.Errorf("register: %d %s", res.StatusCode, b)
	}
	return nil
}

func (s *Service) setMatrixPassword(username, pin string) error {
	// Synapse admin API: reset password (admin token via shared-secret session
	// is deployment config; here the management token authenticates).
	body, _ := json.Marshal(map[string]any{"new_password": pin, "logout_devices": true})
	req, _ := http.NewRequest("POST",
		fmt.Sprintf("%s/_synapse/admin/v2/users/@%s:%s", s.cfg.Homeserver, username, s.cfg.UsernameRealm),
		strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.cfg.MgmtToken)
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("set password: %d", res.StatusCode)
	}
	return nil
}

func (s *Service) deactivateMatrixUser(username string) error {
	body, _ := json.Marshal(map[string]any{"deactivated": true})
	req, _ := http.NewRequest("PUT",
		fmt.Sprintf("%s/_synapse/admin/v2/users/@%s:%s", s.cfg.Homeserver, username, s.cfg.UsernameRealm),
		strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.cfg.MgmtToken)
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("deactivate: %d", res.StatusCode)
	}
	return nil
}

// --- registry gate -------------------------------------------------------------

func (s *Service) patientExists(patientID, phone string) bool {
	res, err := s.client.Get(fmt.Sprintf("%s/patients/search?id=%s&phone=%s",
		s.cfg.RegistryURL, patientID, normPhone(phone)))
	if err != nil {
		return false // fail closed: registry unreachable = no provisioning
	}
	defer res.Body.Close()
	var out struct {
		Results []any `json:"results"`
	}
	if json.NewDecoder(res.Body).Decode(&out) != nil {
		return false
	}
	return res.StatusCode == 200 && len(out.Results) > 0
}

// --- durability: spool, audit, persistence -------------------------------------

func (s *Service) spool(username, code string) {
	_ = os.WriteFile(filepath.Join(s.cfg.DataDir, "spool-create-"+username), []byte(code), 0o600)
	s.audit("spool-create", username, "homeserver down")
}

func (s *Service) spoolRevoke(username string) {
	_ = os.WriteFile(filepath.Join(s.cfg.DataDir, "spool-revoke-"+username), []byte("1"), 0o600)
	s.audit("spool-revoke", username, "homeserver down")
}

func (s *Service) spoolWorker() {
	for {
		files, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "spool-*"))
		for _, f := range files {
			base := filepath.Base(f)
			username := strings.TrimPrefix(strings.TrimPrefix(base, "spool-create-"), "spool-revoke-")
			var err error
			if strings.HasPrefix(base, "spool-create-") {
				code, _ := os.ReadFile(f)
				err = s.createMatrixUser(username, string(code))
			} else {
				err = s.deactivateMatrixUser(username)
			}
			if err == nil {
				_ = os.Remove(f)
				s.audit("spool-replayed", username, "")
			}
		}
		time.Sleep(10 * time.Second)
	}
}

func (s *Service) audit(action, subject, detail string) {
	f, err := os.OpenFile(filepath.Join(s.cfg.DataDir, "audit.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%d %s %s %s\n", time.Now().Unix(), action, subject, detail)
}

func (s *Service) persist(a *Account) {
	raw, _ := json.Marshal(a)
	_ = os.WriteFile(filepath.Join(s.cfg.DataDir, "account-"+a.Username+".json"), raw, 0o600)
}

func (s *Service) load() {
	files, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "account-*.json"))
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var a Account
		if json.Unmarshal(raw, &a) == nil {
			s.accounts[a.Username] = &a
		}
	}
}

// --- helpers ---------------------------------------------------------------------

func usernameFor(patientID string) string {
	// OH-KD-0001 -> oh-kd-0001 (matrix-safe localpart)
	return strings.ToLower(strings.ReplaceAll(patientID, "_", "-"))
}

func setupCode() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return strings.ToUpper(base64.RawURLEncoding.EncodeToString(b)[:10])
}

func hashCode(code string) string {
	sum := sha256.Sum256([]byte(strings.ToUpper(strings.TrimSpace(code))))
	return hex.EncodeToString(sum[:])
}

func subtleCompare(a, b string) int {
	if len(a) != len(b) {
		return 0
	}
	d := byte(0)
	for i := range a {
		d |= a[i] ^ b[i]
	}
	if d == 0 {
		return 1
	}
	return 0
}

func subtleEq(a, b string) bool { return subtleCompare(a, b) == 1 }

func normPhone(p string) string {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, p)
	if len(digits) == 11 && strings.HasPrefix(digits, "0") {
		return "234" + digits[1:]
	}
	return digits
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	raw, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	w.Write(raw)
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
