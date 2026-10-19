package app

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// @use-case docs/feature/administration/use-case/inspect-instance.md
func TestAdministrationLogsAndOverview(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	b := anotherAccount(t, f, "ordinary")
	for _, path := range []string{"overview", "audit-events", "runtime-events"} {
		b.json(t, "GET", "/api/v1/admin/"+path, nil, 403, "")
		resp, e := http.Get(f.server.URL + "/api/v1/admin/" + path)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatal(resp.StatusCode)
		}
	}
	_, o := f.json(t, "GET", "/api/v1/admin/overview", nil, 200, "")
	if o["users"].(map[string]any)["total"] != float64(2) {
		t.Fatal(o)
	}
	f.json(t, "PATCH", "/api/v1/admin/registration", map[string]any{"registration_open": false}, 200, "")
	_, audit := f.json(t, "GET", "/api/v1/admin/audit-events?action=registration_updated", nil, 200, "")
	if len(audit["items"].([]any)) != 1 {
		t.Fatal(audit)
	}
	for i := 0; i < 3; i++ {
		_, err := f.db.Exec(ctx, `INSERT INTO admin_audit_events(id,action,details,created_at) VALUES($1,'account_updated','{"role":"admin","password":"SECRET","old_status":"SECRET"}', '2026-01-01')`, uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	path := "/api/v1/admin/audit-events?action=account_updated&limit=1"
	for {
		_, page := f.json(t, "GET", path, nil, 200, "")
		for _, v := range page["items"].([]any) {
			item := v.(map[string]any)
			id := item["id"].(string)
			if seen[id] {
				t.Fatal("duplicate")
			}
			seen[id] = true
			if strings.Contains(string(jsonBytes(item)), "SECRET") {
				t.Fatal("leaked details")
			}
		}
		if page["next_cursor"] == nil {
			break
		}
		path = "/api/v1/admin/audit-events?action=account_updated&limit=1&cursor=" + page["next_cursor"].(string)
	}
	if len(seen) != 3 {
		t.Fatal(seen)
	}
	for _, q := range []string{"cursor=eA", "from=bad", "from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z", "limit=101", "action=bad", "actor_id=bad"} {
		f.json(t, "GET", "/api/v1/admin/audit-events?"+q, nil, 400, "")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /private/{secret}", f.a.handle(func(http.ResponseWriter, *http.Request) error { return errors.New("SECRET") }))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/private/SECRET?key=SECRET", nil))
	_, logs := f.json(t, "GET", "/api/v1/admin/runtime-events?request_id="+rr.Header().Get("X-Request-ID"), nil, 200, "")
	raw := string(jsonBytes(logs))
	if strings.Contains(raw, "SECRET") || !strings.Contains(raw, "GET /private/{secret}") {
		t.Fatal(raw)
	}
	second := New(f.a.Config, f.db)
	if err := second.pruneRuntime(ctx); err != nil {
		t.Fatal(err)
	}
	_, err := f.db.Exec(ctx, `INSERT INTO runtime_events(id,created_at,instance_id,kind,code) VALUES($1,clock_timestamp()-interval '8 days',$2,'maintenance_failed','internal')`, uuid.NewString(), second.InstanceID)
	if err != nil {
		t.Fatal(err)
	}
	_, logs = f.json(t, "GET", "/api/v1/admin/runtime-events", nil, 200, "")
	if len(logs["items"].([]any)) != 1 {
		t.Fatal(logs)
	}
	second.Config.RestoreMode = true
	cctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { second.Run(cctx); close(done) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var n int
		if err := f.db.QueryRow(ctx, "SELECT count(*) FROM runtime_events").Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cleanup did not run in restore mode")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not stop")
	}
	f.a.runtimeWriting.Store(true)
	f.a.recordRuntime(ctx, "request_failed", "internal", "", "", 500, "")
	f.a.runtimeWriting.Store(false)
	if f.a.runtimeDropped.Load() != 1 {
		t.Fatal("missing drop count")
	}
	var n int
	_ = f.db.QueryRow(ctx, "SELECT count(*) FROM admin_audit_events").Scan(&n)
	if n < 4 {
		t.Fatal("audit removed")
	}
}

// @use-case docs/feature/administration/use-case/inspect-instance.md
func TestRuntimeFailureEntryAndBoundedWriter(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	f.upload(t, wav(1), map[string]any{}, uuid.NewString(), 201)
	j, err := f.a.claim(ctx, "prepare")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.a.failJob(ctx, j, errors.New("SECRET")); err != nil {
		t.Fatal(err)
	}
	var kind, code string
	if err = f.db.QueryRow(ctx, "SELECT kind,code FROM runtime_events WHERE job_id=$1", j.ID).Scan(&kind, &code); err != nil {
		t.Fatal(err)
	}
	if kind != "job_failed" || code != "processing_failed" {
		t.Fatal(kind, code)
	}
	tx, err := f.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "LOCK TABLE runtime_events IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	f.a.recordRuntime(ctx, "maintenance_failed", "internal", "", "", 0, "")
	if time.Since(start) > time.Second || f.a.runtimeDropped.Load() != 1 {
		t.Fatal("writer was not bounded")
	}
}
