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
		if strings.HasPrefix(r.URL.Path, "/staff/search") {
			q := r.URL.Query()
			if q.Get("licence") == "MDCN-4521" && q.Get("role") == "doctor" && q.Get("phone") == "2348022223333" {
				json.NewEncoder(w).Encode(map[string]any{"results": []any{map[string]string{"licence": "MDCN-4521"}}})
				return
			}
			if q.Get("licence") == "NMCN-8890" && q.Get("role") == "nurse" && q.Get("phone") == "2348033334444" {
				json.NewEncoder(w).Encode(map[string]any{"results": []any{map[string]string{"licence": "NMCN-8890"}}})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"results": []any{}})
			return
		}
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

// --- staff provisioning (Phase 5) ---------------------------------------------

func provisionStaff(t *testing.T, s *Service, body string) (string, int) {
	t.Helper()
	rec, req := authed("mgmt", "POST", "/v1/staff/provision", body)
	s.handleStaffProvision(rec, req)
	if rec.Code != 201 {
		return "", rec.Code
	}
	var out struct {
		SetupCode string `json:"setup_code"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	return out.SetupCode, 201
}

func TestStaffProvisionGatedByLicenceRegistry(t *testing.T) {
	s, _ := newTestService(t, false)

	code, status := provisionStaff(t, s,
		`{"licence":"MDCN-4521","role":"doctor","phone":"08022223333","display_name":"Dr. Eze"}`)
	if status != 201 || code == "" {
		t.Fatalf("doctor provision failed: %d", status)
	}
	acct := s.accounts["mdcn-4521"]
	if acct == nil || acct.Kind != "staff" || acct.Role != "doctor" {
		t.Fatalf("bad staff account: %+v", acct)
	}

	// wrong role for the same licence -> fail closed
	_, st := provisionStaff(t, s, `{"licence":"MDCN-4521","role":"nurse","phone":"08022223333"}`)
	if st != 404 {
		t.Fatalf("role mismatch must fail closed, got %d", st)
	}
	// unknown licence -> 404
	_, st = provisionStaff(t, s, `{"licence":"MDCN-0000","role":"doctor","phone":"08022223333"}`)
	if st != 404 {
		t.Fatalf("phantom licence must 404, got %d", st)
	}
	// bad role name -> 400
	_, st = provisionStaff(t, s, `{"licence":"MDCN-4521","role":"surgeon-general","phone":"08022223333"}`)
	if st != 400 {
		t.Fatalf("unknown role must 400, got %d", st)
	}
	// duplicate -> 409
	_, st = provisionStaff(t, s, `{"licence":"MDCN-4521","role":"doctor","phone":"08022223333"}`)
	if st != 409 {
		t.Fatalf("duplicate must 409, got %d", st)
	}
}

func TestStaffActivateFailClosed(t *testing.T) {
	s, _ := newTestService(t, false)
	code, _ := provisionStaff(t, s,
		`{"licence":"NMCN-8890","role":"nurse","phone":"08033334444","display_name":"Nurse Ada"}`)

	act := func(body string) int {
		rec, req := httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/staff/activate", strings.NewReader(body))
		s.handleStaffActivate(rec, req)
		return rec.Code
	}
	if c := act(`{"username":"nmcn-8890","setup_code":"WRONGCODE1","licence":"NMCN-8890","phone":"08033334444","pin":"1234"}`); c != 404 {
		t.Fatalf("wrong code must 404, got %d", c)
	}
	if c := act(`{"username":"nmcn-8890","setup_code":"`+code+`","licence":"NMCN-0000","phone":"08033334444","pin":"1234"}`); c != 404 {
		t.Fatalf("wrong licence must 404, got %d", c)
	}
	// a patient account must not activate via the staff path
	recP, reqP := authed("mgmt", "POST", "/v1/provision", `{"patient_id":"OH-KD-0001","phone":"08011112222"}`)
	s.handleProvision(recP, reqP)
	var pout struct{ SetupCode string `json:"setup_code"` }
	json.Unmarshal(recP.Body.Bytes(), &pout)
	if c := act(`{"username":"oh-kd-0001","setup_code":"`+pout.SetupCode+`","licence":"NMCN-8890","phone":"08011112222","pin":"1234"}`); c != 404 {
		t.Fatalf("patient on staff path must 404, got %d", c)
	}
	// correct activation
	if c := act(`{"username":"nmcn-8890","setup_code":"`+code+`","licence":"NMCN-8890","phone":"08033334444","pin":"1234"}`); c != 200 {
		t.Fatalf("correct activation must 200, got %d", c)
	}
	// replay burned
	if c := act(`{"username":"nmcn-8890","setup_code":"`+code+`","licence":"NMCN-8890","phone":"08033334444","pin":"1234"}`); c != 404 {
		t.Fatalf("replay must 404, got %d", c)
	}
}

// --- escalation queue -----------------------------------------------------------

func activatePatient(t *testing.T, s *Service) {
	t.Helper()
	rec, req := authed("mgmt", "POST", "/v1/provision", `{"patient_id":"OH-KD-0001","phone":"08011112222"}`)
	s.handleProvision(rec, req)
	var out struct{ SetupCode string `json:"setup_code"` }
	json.Unmarshal(rec.Body.Bytes(), &out)
	rec2, req2 := httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/activate", strings.NewReader(
		`{"username":"oh-kd-0001","setup_code":"`+out.SetupCode+`","patient_id":"OH-KD-0001","phone":"08011112222","pin":"1234"}`))
	s.handleActivate(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("patient activation failed: %d", rec2.Code)
	}
}

func TestEscalationQueueLifecycle(t *testing.T) {
	s, _ := newTestService(t, false)
	activatePatient(t, s)
	code, _ := provisionStaff(t, s, `{"licence":"MDCN-4521","role":"doctor","phone":"08022223333"}`)
	recA, reqA := httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/staff/activate", strings.NewReader(
		`{"username":"mdcn-4521","setup_code":"`+code+`","licence":"MDCN-4521","phone":"08022223333","pin":"1234"}`))
	s.handleStaffActivate(recA, reqA)

	// patient escalates
	esc := func(body string) (*httptest.ResponseRecorder, *http.Request) {
		return httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/escalate", strings.NewReader(body))
	}
	rec, req := esc(`{"username":"oh-kd-0001","room_id":"!r1:clinic.ng","reason":"chest pain"}`)
	s.handleEscalate(rec, req)
	if rec.Code != 201 {
		t.Fatalf("escalate failed: %d", rec.Code)
	}
	var eout struct{ ID string `json:"id"` }
	json.Unmarshal(rec.Body.Bytes(), &eout)

	// unknown account cannot escalate
	rec, req = esc(`{"username":"ghost","room_id":"!r9:clinic.ng"}`)
	s.handleEscalate(rec, req)
	if rec.Code != 404 {
		t.Fatalf("phantom escalate must 404, got %d", rec.Code)
	}
	// same room re-escalate is idempotent
	rec, req = esc(`{"username":"oh-kd-0001","room_id":"!r1:clinic.ng","reason":"still waiting"}`)
	s.handleEscalate(rec, req)
	if rec.Code != 200 {
		t.Fatalf("re-escalate must be idempotent 200, got %d", rec.Code)
	}

	// queue shows one waiting entry
	recQ, reqQ := authed("mgmt", "GET", "/v1/queue", "")
	s.handleQueue(recQ, reqQ)
	var qout struct {
		Queue []Escalation `json:"queue"`
	}
	json.Unmarshal(recQ.Body.Bytes(), &qout)
	if len(qout.Queue) != 1 || qout.Queue[0].Status != "waiting" {
		t.Fatalf("bad queue: %+v", qout.Queue)
	}

	// patient account cannot claim (not staff)
	recC, reqC := authed("mgmt", "POST", "/v1/queue/claim", `{"id":"`+eout.ID+`","staff_username":"oh-kd-0001"}`)
	s.handleClaim(recC, reqC)
	if recC.Code != 404 {
		t.Fatalf("patient claim must 404, got %d", recC.Code)
	}
	// doctor claims
	recC, reqC = authed("mgmt", "POST", "/v1/queue/claim", `{"id":"`+eout.ID+`","staff_username":"mdcn-4521"}`)
	s.handleClaim(recC, reqC)
	if recC.Code != 200 {
		t.Fatalf("doctor claim failed: %d", recC.Code)
	}
	// a second staff member cannot steal the claim — provision nurse first
	ncode, _ := provisionStaff(t, s, `{"licence":"NMCN-8890","role":"nurse","phone":"08033334444"}`)
	recN, reqN := httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/staff/activate", strings.NewReader(
		`{"username":"nmcn-8890","setup_code":"`+ncode+`","licence":"NMCN-8890","phone":"08033334444","pin":"1234"}`))
	s.handleStaffActivate(recN, reqN)
	recC, reqC = authed("mgmt", "POST", "/v1/queue/claim", `{"id":"`+eout.ID+`","staff_username":"nmcn-8890"}`)
	s.handleClaim(recC, reqC)
	if recC.Code != 409 {
		t.Fatalf("claim steal must 409, got %d", recC.Code)
	}
	// only the claimer resolves
	recR, reqR := authed("mgmt", "POST", "/v1/queue/resolve", `{"id":"`+eout.ID+`","staff_username":"nmcn-8890"}`)
	s.handleResolve(recR, reqR)
	if recR.Code != 409 {
		t.Fatalf("non-claimer resolve must 409, got %d", recR.Code)
	}
	recR, reqR = authed("mgmt", "POST", "/v1/queue/resolve", `{"id":"`+eout.ID+`","staff_username":"mdcn-4521"}`)
	s.handleResolve(recR, reqR)
	if recR.Code != 200 {
		t.Fatalf("resolve failed: %d", recR.Code)
	}
	// resolved entries leave the queue
	recQ, reqQ = authed("mgmt", "GET", "/v1/queue", "")
	s.handleQueue(recQ, reqQ)
	json.Unmarshal(recQ.Body.Bytes(), &qout)
	if len(qout.Queue) != 0 {
		t.Fatalf("resolved escalation still in queue: %+v", qout.Queue)
	}
	// queue survives restart (persistence)
	s2 := &Service{cfg: s.cfg, client: http.DefaultClient, accounts: map[string]*Account{}, queue: []*Escalation{}}
	s2.load()
	if len(s2.queue) != 1 || s2.queue[0].Status != "resolved" || s2.accounts["mdcn-4521"].Role != "doctor" {
		t.Fatalf("state did not survive reload: %+v", s2.queue)
	}
}
