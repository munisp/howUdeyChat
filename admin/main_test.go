package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fake homeserver (Synapse admin API) + fake OpenHealth registry
func newTestService(t *testing.T, hsDown bool) (*Service, *httptest.Server) {
	t.Helper()
	var hs *httptest.Server
	if !hsDown {
		hs = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == "GET" && r.URL.Path == "/_synapse/admin/v1/register":
				json.NewEncoder(w).Encode(map[string]string{"nonce": "abc123"})
			case r.Method == "POST" && r.URL.Path == "/_synapse/admin/v1/register":
				var b map[string]any
				json.NewDecoder(r.Body).Decode(&b)
				if b["mac"] == "" || b["username"] == "" {
					http.Error(w, "bad", 400)
					return
				}
				json.NewEncoder(w).Encode(map[string]string{"user_id": "@" + b["username"].(string) + ":clinic.ng"})
			case strings.HasPrefix(r.URL.Path, "/_synapse/admin/v2/users/"):
				json.NewEncoder(w).Encode(map[string]string{})
			default:
				http.NotFound(w, r)
			}
		}))
	} else {
		hs = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "down", 502)
		}))
	}
	t.Cleanup(hs.Close)

	reg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.RawQuery, "OH-KD-0001") && strings.Contains(r.URL.RawQuery, "2348011112222") {
			json.NewEncoder(w).Encode(map[string]any{"results": []any{map[string]string{"id": "OH-KD-0001"}}})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"results": []any{}})
	}))
	t.Cleanup(reg.Close)

	dir := t.TempDir()
	s := &Service{
		cfg: Config{
			Homeserver: hs.URL, SharedSecret: "test-secret", RegistryURL: reg.URL,
			MgmtToken: "mgmt", DataDir: dir, UsernameRealm: "clinic.ng",
		},
		client: http.DefaultClient, accounts: map[string]*Account{},
	}
	return s, hs
}

func authed(token, method, path, body string) (*httptest.ResponseRecorder, *http.Request) {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	return httptest.NewRecorder(), req
}

func TestProvisionCreatesAccountAndMatrixUser(t *testing.T) {
	s, _ := newTestService(t, false)
	rec, req := authed("mgmt", "POST", "/v1/provision",
		`{"patient_id":"OH-KD-0001","phone":"08011112222","display_name":"Amina Musa"}`)
	s.handleProvision(rec, req)
	if rec.Code != 201 {
		t.Fatalf("want 201, got %d: %s", rec.Code, rec.Body)
	}
	var out struct {
		Username  string `json:"username"`
		SetupCode string `json:"setup_code"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Username != "oh-kd-0001" || len(out.SetupCode) != 10 {
		t.Fatalf("bad provision output: %+v", out)
	}
	acct := s.accounts["oh-kd-0001"]
	if acct.CodeHash == out.SetupCode {
		t.Fatal("setup code must be stored hashed, never in clear")
	}
	if acct.Phone != "2348011112222" {
		t.Fatalf("phone not normalized: %s", acct.Phone)
	}
}

func TestProvisionRejectsUnknownPatient(t *testing.T) {
	s, _ := newTestService(t, false)
	rec, req := authed("mgmt", "POST", "/v1/provision",
		`{"patient_id":"OH-XX-9999","phone":"08011112222"}`)
	s.handleProvision(rec, req)
	if rec.Code != 404 {
		t.Fatalf("phantom patient must not provision, got %d", rec.Code)
	}
}

func TestActivateFailClosed(t *testing.T) {
	s, _ := newTestService(t, false)
	rec, req := authed("mgmt", "POST", "/v1/provision", `{"patient_id":"OH-KD-0001","phone":"08011112222"}`)
	s.handleProvision(rec, req)
	var prov struct{ SetupCode string `json:"setup_code"` }
	json.Unmarshal(rec.Body.Bytes(), &prov)

	activate := func(body string) int {
		rec2, req2 := httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/activate", strings.NewReader(body))
		s.handleActivate(rec2, req2)
		return rec2.Code
	}
	// wrong code
	if c := activate(`{"username":"oh-kd-0001","setup_code":"WRONG","patient_id":"OH-KD-0001","phone":"08011112222","pin":"4321"}`); c != 404 {
		t.Fatalf("wrong code must 404, got %d", c)
	}
	// right code, wrong phone pair
	if c := activate(`{"username":"oh-kd-0001","setup_code":"`+prov.SetupCode+`","patient_id":"OH-KD-0001","phone":"08099999999","pin":"4321"}`); c != 404 {
		t.Fatalf("wrong pair must 404, got %d", c)
	}
	// everything right
	if c := activate(`{"username":"oh-kd-0001","setup_code":"`+prov.SetupCode+`","patient_id":"OH-KD-0001","phone":"08011112222","pin":"4321"}`); c != 200 {
		t.Fatalf("valid activation must 200, got %d", c)
	}
	// code burned: replay must fail
	if c := activate(`{"username":"oh-kd-0001","setup_code":"`+prov.SetupCode+`","patient_id":"OH-KD-0001","phone":"08011112222","pin":"4321"}`); c != 404 {
		t.Fatalf("replayed code must fail, got %d", c)
	}
}

func TestManagementEndpointsRequireToken(t *testing.T) {
	s, _ := newTestService(t, false)
	rec, req := httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/accounts", nil)
	s.auth(s.handleAccounts)(rec, req)
	if rec.Code != 401 {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

func TestRevokeMarksAndCallsHomeserver(t *testing.T) {
	s, _ := newTestService(t, false)
	rec, req := authed("mgmt", "POST", "/v1/provision", `{"patient_id":"OH-KD-0001","phone":"08011112222"}`)
	s.handleProvision(rec, req)
	rec2, req2 := authed("mgmt", "POST", "/v1/revoke", `{"username":"oh-kd-0001","reason":"phone lost"}`)
	s.handleRevoke(rec2, req2)
	if rec2.Code != 200 || !s.accounts["oh-kd-0001"].Revoked {
		t.Fatalf("revoke failed: %d", rec2.Code)
	}
	// revoked account cannot activate
	rec3, req3 := httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/activate",
		strings.NewReader(`{"username":"oh-kd-0001","setup_code":"x","patient_id":"OH-KD-0001","phone":"08011112222","pin":"1"}`))
	s.handleActivate(rec3, req3)
	if rec3.Code != 404 {
		t.Fatal("revoked account must not activate")
	}
}

func TestHomeserverDownSpoolsCreate(t *testing.T) {
	s, _ := newTestService(t, true) // homeserver 502s
	rec, req := authed("mgmt", "POST", "/v1/provision", `{"patient_id":"OH-KD-0001","phone":"08011112222"}`)
	s.handleProvision(rec, req)
	if rec.Code != 201 {
		t.Fatalf("provisioning must succeed for the desk even when HS down, got %d", rec.Code)
	}
	files, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "spool-create-*"))
	if len(files) != 1 {
		t.Fatal("create must be spooled for replay when homeserver recovers")
	}
}

func TestAuditLogWritten(t *testing.T) {
	s, _ := newTestService(t, false)
	rec, req := authed("mgmt", "POST", "/v1/provision", `{"patient_id":"OH-KD-0001","phone":"08011112222"}`)
	s.handleProvision(rec, req)
	raw, _ := os.ReadFile(filepath.Join(s.cfg.DataDir, "audit.log"))
	if !strings.Contains(string(raw), "provision oh-kd-0001 OH-KD-0001") {
		t.Fatalf("audit missing provision line: %s", raw)
	}
}
