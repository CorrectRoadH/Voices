package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"
	"voices/internal/updates"
)

func updateUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"schemaVersion":1,"latestVersion":"1.10.0","releaseUrl":"https://github.com/CorrectRoadH/Voices/releases/tag/v1.10.0","releasedAt":"2026-01-01T00:00:00Z","releaseNotes":"Release notes <img src=x onerror=alert(1)>","announcements":[{"id":"notice","title":"升级公告","body":"先备份数据库，再更新镜像。","severity":"warning","publishedAt":"2026-01-01T00:00:00Z","expiresAt":null,"link":null}]}`)
	}))
	t.Cleanup(server.Close)
	return server
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestUpdatesAdminBoundary(t *testing.T) {
	f := setup(t)
	server := updateUpstream(t)
	f.a.Updates = updates.New(context.Background(), "1.9.0", server.URL, server.Client())
	defer f.a.Updates.Close()
	_, state := f.json(t, "GET", "/api/v1/admin/updates", nil, 200, "")
	if state["status"] != "unchecked" {
		t.Fatal(state)
	}
	saved := f.csrf
	f.csrf = ""
	f.json(t, "POST", "/api/v1/admin/updates", nil, 403, "")
	f.csrf = saved
	_, state = f.json(t, "POST", "/api/v1/admin/updates", nil, 200, "")
	if state["status"] != "ok" || state["update_available"] != true {
		t.Fatal(state)
	}
	ordinary := anotherAccount(t, f, "ordinary-update")
	ordinary.json(t, "GET", "/api/v1/admin/updates", nil, 403, "")
	ordinary.json(t, "POST", "/api/v1/admin/updates", nil, 403, "")
	f.a.Config.RestoreMode = true
	f.json(t, "POST", "/api/v1/admin/updates", nil, 409, "")
	f.json(t, "GET", "/api/v1/admin/updates", nil, 200, "")
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestUpdatesBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	f := setupAccountFixture(t, false)
	seedFixtureSettings(t, f)
	f.a.Config.WebDir = "../../web/dist"
	upstream := updateUpstream(t)
	f.a.Updates = updates.New(context.Background(), "1.9.0", upstream.URL, upstream.Client())
	defer f.a.Updates.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "../../web/scripts/updates-stack.mjs")
	cmd.Env = append(os.Environ(), "VOICES_TEST_URL="+f.server.URL)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestUpdateURLConfig(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("UPDATE_URL", "https://updates.example.test/")
	if c, err := LoadConfig(); err != nil || c.UpdateURL != "https://updates.example.test/" {
		t.Fatal(c.UpdateURL, err)
	}
	t.Setenv("UPDATE_URL", "http://updates.example.test/")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("insecure URL accepted")
	}
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestUpdatesUnauthorizedDoesNotFetch(t *testing.T) {
	f := setupAccountFixture(t, false)
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer server.Close()
	f.a.Updates = updates.New(context.Background(), "1.0.0", server.URL, server.Client())
	defer f.a.Updates.Close()
	f.json(t, "GET", "/api/v1/admin/updates", nil, 401, "")
	f.json(t, "POST", "/api/v1/admin/updates", nil, 401, "")
	if calls.Load() != 0 {
		t.Fatal("unauthorized fetch")
	}
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestTelemetryConfigDefaultsAndOptOut(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	// Ensure absent variables, while preserving the outer environment after this test.
	for _, key := range []string{"UPDATE_URL", "UPDATE_TELEMETRY"} {
		t.Setenv(key, "")
		os.Unsetenv(key)
	}
	c, err := LoadConfig()
	if err != nil || !c.UpdateTelemetry || c.UpdateURL != "https://voices.niceeval.com/" {
		t.Fatalf("defaults: %+v %v", c.UpdateTelemetry, err)
	}
	t.Setenv("UPDATE_TELEMETRY", "false")
	c, err = LoadConfig()
	if err != nil || c.UpdateTelemetry {
		t.Fatal("opt-out failed", err)
	}
	t.Setenv("UPDATE_URL", "")
	c, err = LoadConfig()
	if err != nil || c.UpdateURL != "" {
		t.Fatal("explicit empty ignored", err)
	}
	t.Setenv("UPDATE_TELEMETRY", "invalid")
	if _, err = LoadConfig(); err == nil {
		t.Fatal("invalid flag accepted")
	}
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestTelemetryIdentityAndRecovery(t *testing.T) {
	f := setupAccountFixture(t, false)
	f.a.Config.UpdateTelemetry = true
	f.a.Config.UpdateURL = "https://voices.niceeval.com/"
	first := f.a.UpdateTelemetry(context.Background())
	if first == nil || first.InstanceID == f.a.InstanceID {
		t.Fatal("persistent identity missing or reused lease owner")
	}
	second := f.a.UpdateTelemetry(context.Background())
	if second == nil || second.InstanceID != first.InstanceID {
		t.Fatal("identity changed")
	}
	f.a.Config.RestoreMode = true
	if f.a.UpdateTelemetry(context.Background()) != nil {
		t.Fatal("recovery sent telemetry")
	}
	f.a.Config.RestoreMode = false
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if f.a.UpdateTelemetry(ctx) != nil {
		t.Fatal("cancelled query did not degrade")
	}
	if _, err := f.db.Exec(context.Background(), "INSERT INTO instance_identity(id) VALUES(2)"); err == nil {
		t.Fatal("singleton constraint absent")
	}
}
