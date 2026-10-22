package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"

	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func anotherAccount(t *testing.T, f *fixture, name string) *fixture {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	b := &fixture{a: f.a, db: f.db, server: f.server, client: &http.Client{Jar: jar}}
	_, s := b.json(t, "POST", "/api/v1/users", map[string]any{"email": name + "@example.test", "display_name": name, "password": "acceptance-password"}, 201, "")
	b.csrf = s["csrf_token"].(string)
	return b
}
func userID(t *testing.T, f *fixture) string {
	t.Helper()
	_, s := f.json(t, "GET", "/api/v1/session", nil, 200, "")
	return s["user"].(map[string]any)["id"].(string)
}

// @use-case docs/feature/accounts/use-case/register.md
func TestConcurrentFirstRegistrationAcrossInstances(t *testing.T) {
	f := setupAccountFixture(t, false)
	second := httptest.NewServer(New(f.a.Config, f.db).Handler())
	defer second.Close()
	var wg sync.WaitGroup
	results := make(chan string, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			base := f.server.URL
			if i%2 == 1 {
				base = second.URL
			}
			body := jsonBytes(map[string]any{"email": fmt.Sprintf("person%d@example.test", i), "display_name": "Person", "password": "acceptance-password"})
			res, err := http.Post(base+"/api/v1/users", "application/json", bytes.NewReader(body))
			if err != nil {
				results <- err.Error()
				return
			}
			defer res.Body.Close()
			if res.StatusCode == 409 {
				results <- "pending"
				return
			}
			if res.StatusCode != 201 {
				raw, _ := io.ReadAll(res.Body)
				results <- fmt.Sprintf("status %d %s", res.StatusCode, raw)
				return
			}
			var session struct {
				User User `json:"user"`
			}
			if err := json.NewDecoder(res.Body).Decode(&session); err != nil {
				results <- err.Error()
				return
			}
			results <- session.User.Role
		}(i)
	}
	wg.Wait()
	close(results)
	admins := 0
	for role := range results {
		if role == "admin" {
			admins++
		} else if role != "pending" {
			t.Error(role)
		}
	}
	if admins != 1 {
		t.Fatalf("admins=%d", admins)
	}
	_, s := f.json(t, "GET", "/api/v1/auth/status", nil, 200, "")
	if s["initialized"] != true {
		t.Fatal(s)
	}
	f.json(t, "POST", "/api/v1/users", map[string]any{"email": "person0@example.test", "display_name": "Duplicate", "password": "acceptance-password"}, 409, "")
	var count int
	f.db.QueryRow(context.Background(), "SELECT count(*) FROM users").Scan(&count)
	if count != 1 {
		t.Fatalf("users=%d", count)
	}
}

// @use-case docs/feature/accounts/use-case/isolate-data.md
func TestAccountBusinessIsolation(t *testing.T) {
	fakeRemote(t)
	a := setup(t)
	b := anotherAccount(t, a, "other")
	key := uuid.NewString()
	meta := map[string]any{"title": "Private recording", "auto_transcribe": true, "transcription_options": options()}
	outA := a.upload(t, wav(20), meta, key, 201)
	ridA := outA["recording"].(map[string]any)["id"].(string)
	outB := b.upload(t, wav(20), meta, key, 201)
	ridB := outB["recording"].(map[string]any)["id"].(string)
	if ridA == ridB {
		t.Fatal("cross-account digest deduplication")
	}
	a.upload(t, wav(20), meta, key, 200)
	b.upload(t, wav(20), meta, key, 200)
	a.run(t, "prepare")
	a.run(t, "prepare")
	a.run(t, "transcribe")
	a.run(t, "transcribe")
	_, pa := a.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "Alice"}, 201, key)
	_, pb := b.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "Bob"}, 201, key)
	if pa["id"] == pb["id"] {
		t.Fatal("cross-account idempotency")
	}
	a.json(t, "PATCH", "/api/v1/settings", map[string]any{"default_transcription": options(), "auto_transcribe": true}, 200, "")
	_, settings := b.json(t, "GET", "/api/v1/settings", nil, 200, "")
	if settings["auto_transcribe"] != false {
		t.Fatal("settings leak", settings)
	}
	for _, f := range []*fixture{a, b} {
		otherRID, otherPID := ridB, pb["id"].(string)
		ownRID := ridA
		if f == b {
			otherRID, otherPID = ridA, pa["id"].(string)
			ownRID = ridB
		}
		_, list := f.json(t, "GET", "/api/v1/recordings", nil, 200, "")
		items := list["items"].([]any)
		if len(items) != 1 || items[0].(map[string]any)["id"] != ownRID {
			t.Fatal("recordings leak", list)
		}
		_, people := f.json(t, "GET", "/api/v1/people", nil, 200, "")
		if len(people["items"].([]any)) != 1 {
			t.Fatal("people leak")
		}
		_, jobs := f.json(t, "GET", "/api/v1/jobs?recording_id="+otherRID, nil, 200, "")
		if len(jobs["items"].([]any)) != 0 {
			t.Fatal("job filter leak")
		}
		var tid, sid, label, jid string
		if err := f.db.QueryRow(context.Background(), "SELECT id FROM transcriptions WHERE recording_id=$1", otherRID).Scan(&tid); err != nil {
			t.Fatal(err)
		}
		f.db.QueryRow(context.Background(), "SELECT id FROM segments WHERE transcription_id=$1 LIMIT 1", tid).Scan(&sid)
		f.db.QueryRow(context.Background(), "SELECT id FROM speaker_labels WHERE transcription_id=$1 LIMIT 1", tid).Scan(&label)
		f.db.QueryRow(context.Background(), "SELECT id FROM jobs WHERE recording_id=$1 LIMIT 1", otherRID).Scan(&jid)
		paths := []struct{ method, path string }{
			{"GET", "/recordings/" + otherRID}, {"PATCH", "/recordings/" + otherRID}, {"DELETE", "/recordings/" + otherRID},
			{"GET", "/recordings/" + otherRID + "/audio"}, {"HEAD", "/recordings/" + otherRID + "/audio"},
			{"GET", "/recordings/" + otherRID + "/transcriptions"}, {"POST", "/recordings/" + otherRID + "/transcriptions"},
			{"GET", "/people/" + otherPID}, {"PATCH", "/people/" + otherPID},
			{"GET", "/transcriptions/" + tid}, {"GET", "/transcriptions/" + tid + "/segments"}, {"POST", "/transcriptions/" + tid + "/activate"}, {"POST", "/transcriptions/" + tid + "/cancel"}, {"GET", "/transcriptions/" + tid + "/export?format=json"}, {"POST", "/transcriptions/" + tid + "/speaker-labels"},
			{"GET", "/segments/" + sid}, {"PATCH", "/segments/" + sid}, {"PATCH", "/speaker-labels/" + label}, {"POST", "/jobs/" + jid + "/retry"}, {"POST", "/jobs/" + jid + "/resolve"},
		}
		for _, p := range paths {
			f.request(t, p.method, "/api/v1"+p.path, bytes.NewBufferString("{}"), "application/json", 404, uuid.NewString())
		}
		var ownTID string
		f.db.QueryRow(context.Background(), "SELECT id FROM transcriptions WHERE recording_id=$1", ownRID).Scan(&ownTID)
		f.json(t, "POST", "/api/v1/transcriptions/"+ownTID+"/speaker-labels", map[string]any{"display_name": "Cross account", "person_id": otherPID}, 404, uuid.NewString())
		// Composite FK independently rejects a cross-account association.
		_, err := f.db.Exec(context.Background(), "INSERT INTO speaker_labels(id,transcription_id,display_name,person_id) VALUES($1,$2,'invalid',$3)", uuid.NewString(), ownTID, otherPID)
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != "23503" {
			t.Fatalf("expected ownership FK failure, got %v", err)
		}
	}
	var mismatches int
	if err := a.db.QueryRow(context.Background(), "SELECT count(*) FROM media_assets m JOIN blobs b ON b.id=m.blob_id WHERE m.owner_id<>b.owner_id").Scan(&mismatches); err != nil || mismatches != 0 {
		t.Fatal("blob ownership", mismatches, err)
	}
}

// @use-case docs/feature/accounts/use-case/manage-access.md
func TestAccountManagementAndSessions(t *testing.T) {
	a := setup(t)
	b := anotherAccount(t, a, "other")
	aid, bid := userID(t, a), userID(t, b)
	b.json(t, "GET", "/api/v1/admin/users", nil, 403, "")
	a.json(t, "PATCH", "/api/v1/admin/users/"+aid, map[string]any{"role": "user"}, 409, "")
	a.json(t, "PATCH", "/api/v1/admin/users/"+aid, map[string]any{"status": "disabled"}, 409, "")
	a.json(t, "PATCH", "/api/v1/admin/registration", map[string]any{"registration_open": false}, 200, "")
	a.json(t, "POST", "/api/v1/users", map[string]any{"email": "third@example.test", "display_name": "Third", "password": "acceptance-password"}, 403, "")
	a.json(t, "PATCH", "/api/v1/admin/users/"+bid, map[string]any{"status": "disabled"}, 200, "")
	b.json(t, "GET", "/api/v1/session", nil, 401, "")
	b.json(t, "POST", "/api/v1/session", map[string]any{"email": "other@example.test", "password": "acceptance-password"}, 401, "")
	a.json(t, "PATCH", "/api/v1/admin/users/"+bid, map[string]any{"status": "active", "role": "admin"}, 200, "")
	_, s := b.json(t, "POST", "/api/v1/session", map[string]any{"email": "OTHER@example.test", "password": "acceptance-password"}, 200, "")
	b.csrf = s["csrf_token"].(string)
	b.json(t, "GET", "/api/v1/admin/users", nil, 200, "")
	a.json(t, "PATCH", "/api/v1/admin/users/"+bid, map[string]any{"role": "user"}, 200, "")
	b.json(t, "GET", "/api/v1/admin/users", nil, 403, "")
	b.json(t, "PUT", "/api/v1/me/password", map[string]any{"current_password": "wrong", "new_password": "a-different-password"}, 403, "")
	b.json(t, "PUT", "/api/v1/me/password", map[string]any{"current_password": "acceptance-password", "new_password": "a-different-password"}, 204, "")
	b.json(t, "GET", "/api/v1/session", nil, 401, "")
	b.json(t, "POST", "/api/v1/session", map[string]any{"email": "other@example.test", "password": "acceptance-password"}, 401, "")
	_, s = b.json(t, "POST", "/api/v1/session", map[string]any{"email": "other@example.test", "password": "a-different-password"}, 200, "")
	b.csrf = s["csrf_token"].(string)
	cmd := exec.Command("go", "run", "../../cmd/voices", "reset-password", "other@example.test")
	dsn := a.db.Config().ConnString()
	schema := a.db.Config().ConnConfig.RuntimeParams["search_path"]
	if strings.Contains(dsn, "://") {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		q := u.Query()
		q.Set("search_path", schema)
		u.RawQuery = q.Encode()
		dsn = u.String()
	} else {
		dsn += " search_path=" + schema
	}
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "DATABASE_URL="+dsn, "PUBLIC_BASE_URL=http://localhost")
	cmd.Stdin = strings.NewReader("operator-reset-password\n")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("local reset command: %v: %s", err, output)
	}
	b.json(t, "GET", "/api/v1/session", nil, 401, "")
	b.json(t, "POST", "/api/v1/session", map[string]any{"email": "other@example.test", "password": "operator-reset-password"}, 200, "")
}

// @use-case docs/feature/accounts/use-case/manage-access.md
func TestConcurrentLastAdminProtection(t *testing.T) {
	a := setup(t)
	b := anotherAccount(t, a, "other")
	aid, bid := userID(t, a), userID(t, b)
	a.json(t, "PATCH", "/api/v1/admin/users/"+bid, map[string]any{"role": "admin"}, 200, "")
	results := make(chan int, 2)
	var wg sync.WaitGroup
	for _, item := range []struct {
		f  *fixture
		id string
	}{{a, aid}, {b, bid}} {
		wg.Add(1)
		go func(f *fixture, id string) {
			defer wg.Done()
			req, _ := http.NewRequest("PATCH", f.server.URL+"/api/v1/admin/users/"+id, bytes.NewBufferString(`{"role":"user"}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-CSRF-Token", f.csrf)
			res, err := f.client.Do(req)
			if err != nil {
				results <- 0
				return
			}
			defer res.Body.Close()
			results <- res.StatusCode
		}(item.f, item.id)
	}
	wg.Wait()
	close(results)
	successes := 0
	for status := range results {
		if status == 200 {
			successes++
		} else if status != 409 {
			t.Fatalf("unexpected status %d", status)
		}
	}
	if successes != 1 {
		t.Fatalf("successes=%d", successes)
	}
	var count int
	if err := a.db.QueryRow(context.Background(), "SELECT count(*) FROM users WHERE role='admin' AND status='active'").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
}

// @use-case docs/feature/accounts/use-case/register.md
func TestRegistrationValidationAndRestoreMode(t *testing.T) {
	f := setupAccountFixture(t, false)
	for _, password := range []string{"short", strings.Repeat("a", 73)} {
		f.json(t, "POST", "/api/v1/users", map[string]any{"email": "invalid@example.test", "display_name": "Invalid", "password": password}, 400, "")
	}
	_, state := f.json(t, "GET", "/api/v1/auth/status", nil, 200, "")
	if state["initialized"] != false {
		t.Fatal("invalid registration consumed bootstrap")
	}
	f.json(t, "POST", "/api/v1/users", map[string]any{"email": "tester@example.test", "display_name": "User", "password": "acceptance-password", "role": "admin"}, 400, "")
	f.a.Config.RestoreMode = true
	f.json(t, "POST", "/api/v1/users", map[string]any{"email": "tester@example.test", "display_name": "User", "password": "acceptance-password"}, 409, "")
	f.a.Config.RestoreMode = false
	_, s := f.json(t, "POST", "/api/v1/users", map[string]any{"email": "TESTER@example.test", "display_name": "User", "password": "acceptance-password"}, 201, "")
	f.csrf = s["csrf_token"].(string)
	if s["user"].(map[string]any)["role"] != "admin" {
		t.Fatal(s)
	}
	f.a.Config.RestoreMode = true
	f.json(t, "PATCH", "/api/v1/admin/registration", map[string]any{"registration_open": false}, 409, "")
	f.json(t, "GET", "/api/v1/session", nil, 200, "")
	f.json(t, "DELETE", "/api/v1/session", nil, 204, "")
}

// @use-case docs/feature/accounts/use-case/register.md
func TestEmailIdentityNormalization(t *testing.T) {
	f := setupAccountFixture(t, false)
	for _, email := range []string{"not-email", "Named <person@example.test>", "a b@example.test"} {
		_, out := f.json(t, "POST", "/api/v1/users", map[string]any{"email": email, "display_name": "User", "password": "123456"}, 400, "")
		if out["error"].(map[string]any)["code"] != "invalid_email" {
			t.Fatal(out)
		}
	}
	_, out := f.json(t, "POST", "/api/v1/users", map[string]any{"email": " USER+tag@EXAMPLE.test ", "display_name": "访谈用户", "password": "123456"}, 201, "")
	if out["user"].(map[string]any)["email"] != "user+tag@example.test" {
		t.Fatal(out)
	}
	f.json(t, "POST", "/api/v1/users", map[string]any{"email": "user+tag@example.test", "display_name": "Other", "password": "123456"}, 409, "")
	f.json(t, "POST", "/api/v1/session", map[string]any{"email": "User+TAG@example.TEST", "password": "123456"}, 200, "")
	f.json(t, "POST", "/api/v1/session", map[string]any{"username": "user", "password": "123456"}, 400, "")
}

// @use-case docs/feature/accounts/use-case/register.md
func TestUsernameAndEmailLoginShareIdentityAndLimit(t *testing.T) {
	f := setup(t)
	f.json(t, "PATCH", "/api/v1/me", map[string]any{"display_name": "Tester", "username": "Test_User"}, 200, "")
	_, email := f.json(t, "POST", "/api/v1/session", map[string]any{"identifier": "tester@example.test", "password": "acceptance-password"}, 200, "")
	_, alias := f.json(t, "POST", "/api/v1/session", map[string]any{"identifier": " TEST_USER ", "password": "acceptance-password"}, 200, "")
	if email["user"].(map[string]any)["id"] != alias["user"].(map[string]any)["id"] {
		t.Fatal("alias identity mismatch")
	}
	f.csrf = alias["csrf_token"].(string)
	other := anotherAccount(t, f, "alias-other")
	other.json(t, "PATCH", "/api/v1/me", map[string]any{"display_name": "Other", "username": "test_USER"}, 409, "")
	for i := 0; i < 8; i++ {
		identifier := "test_user"
		if i%2 == 0 {
			identifier = "tester@example.test"
		}
		f.json(t, "POST", "/api/v1/session", map[string]any{"identifier": identifier, "password": "wrong-password"}, 401, "")
	}
	f.json(t, "POST", "/api/v1/session", map[string]any{"identifier": "tester@example.test", "password": "wrong-password"}, 429, "")
}

// @use-case docs/feature/administration/use-case/inspect-instance.md
func TestAdminAccountFilterValidation(t *testing.T) {
 f := setup(t)
 b := anotherAccount(t, f, "lookup")
 bid := userID(t, b)
 b.json(t, "PATCH", "/api/v1/me", map[string]any{"display_name": "100% Named_User", "username": "lookup_alias"}, 200, "")
 cases := []struct{ query, id string; count int }{
  {"q="+url.QueryEscape("%"), bid, 1}, {"q="+url.QueryEscape("_"), bid, 1},
 }
 for _, tc := range cases {
  _, result := f.json(t,"GET","/api/v1/admin/users?"+tc.query,nil,200,"")
  items := result["items"].([]any)
  if len(items)!=tc.count { t.Fatalf("%s: count=%d want=%d",tc.query,len(items),tc.count) }
  if tc.count==1 && items[0].(map[string]any)["id"]!=tc.id { t.Fatalf("%s: wrong account",tc.query) }
 }
 for _, q := range []string{"status=unknown","role=owner","q="+strings.Repeat("x",101)} {
  f.json(t,"GET","/api/v1/admin/users?"+q,nil,400,"")
 }
 b.json(t,"GET","/api/v1/admin/users?q=Tester",nil,403,"")
}
