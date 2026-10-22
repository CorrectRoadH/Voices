package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"voices/internal/persistence"
)

func registerSetupAdmin(t *testing.T, f *fixture) {
	t.Helper()
	_, s := f.json(t, "POST", "/api/v1/users", map[string]any{"email": "setup@example.test", "username": "setupadmin", "display_name": "Setup Admin", "password": "123456"}, 201, "")
	f.csrf = s["csrf_token"].(string)
}

// @use-case docs/feature/accounts/use-case/setup-site.md
func TestSiteOnboardingRegistrationAndPermissions(t *testing.T) {
	f := setupAccountFixture(t, false)
	f.json(t, "GET", "/api/v1/admin/onboarding", nil, 401, "")
	registerSetupAdmin(t, f)
	_, status := f.json(t, "GET", "/api/v1/auth/status", nil, 200, "")
	if status["initialized"] != true || status["site_setup_completed"] != false || status["registration_open"] != false {
		t.Fatal(status)
	}
	f.json(t, "POST", "/api/v1/users", map[string]any{"email": "next@example.test", "display_name": "Next", "password": "123456"}, 409, "")
	f.json(t, "POST", "/api/v1/admin/onboarding", map[string]any{"revision": 1, "skip_llm": false}, 409, "")
	f.json(t, "POST", "/api/v1/admin/onboarding", map[string]any{"revision": 2, "skip_llm": true}, 409, "")
	csrf := f.csrf
	f.csrf = ""
	f.json(t, "POST", "/api/v1/admin/onboarding", map[string]any{"revision": 1, "skip_llm": true}, 403, "")
	f.csrf = csrf
	f.a.Config.RestoreMode = true
	f.json(t, "POST", "/api/v1/admin/onboarding", map[string]any{"revision": 1, "skip_llm": true}, 409, "")
	f.json(t, "POST", "/api/v1/admin/llm-test", map[string]any{"revision": 1}, 409, "")
	f.a.Config.RestoreMode = false
	// Leaving does not consume or complete setup; logging in resumes the same state.
	f.json(t, "DELETE", "/api/v1/session", nil, 204, "")
	_, login := f.json(t, "POST", "/api/v1/session", map[string]any{"identifier": "setupadmin", "password": "123456"}, 200, "")
	f.csrf = login["csrf_token"].(string)
	_, pending := f.json(t, "GET", "/api/v1/admin/onboarding", nil, 200, "")
	if pending["completed"] != false {
		t.Fatal(pending)
	}
	for range 2 {
		f.json(t, "POST", "/api/v1/admin/onboarding", map[string]any{"revision": 1, "skip_llm": true}, 200, "")
	}
	_, status = f.json(t, "GET", "/api/v1/auth/status", nil, 200, "")
	if status["registration_open"] != true || status["site_setup_completed"] != true {
		t.Fatal(status)
	}
	other := anotherAccount(t, f, "ordinary")
	other.json(t, "GET", "/api/v1/admin/onboarding", nil, 403, "")
	other.json(t, "POST", "/api/v1/admin/onboarding", map[string]any{"revision": 1, "skip_llm": true}, 403, "")
	other.json(t, "POST", "/api/v1/admin/llm-test", map[string]any{"revision": 1}, 403, "")
	var n int
	if err := f.db.QueryRow(context.Background(), "SELECT count(*) FROM admin_audit_events WHERE action='site_setup_completed'").Scan(&n); err != nil || n != 1 {
		t.Fatal("completion must be idempotent", n, err)
	}
}

func sampleLLM(w http.ResponseWriter) {
	content := string(jsonBytes(map[string]any{"summary": "项目安排", "chapters": []any{map[string]any{"title": "安排", "segment_id": "s1"}}}))
	writeJSON(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": content}}}})
}

// @use-case docs/feature/accounts/use-case/setup-site.md
func TestLLMSetupTestRevisionAndHotConfiguration(t *testing.T) {
	f := setupAccountFixture(t, false)
	registerSetupAdmin(t, f)
	var calls atomic.Int32
	var fail atomic.Bool
	var delay atomic.Bool
	entered, release := make(chan struct{}, 1), make(chan struct{})
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer secret-for-test" {
			t.Error("wrong protocol or credentials")
		}
		if delay.Load() {
			entered <- struct{}{}
			<-release
		}
		if fail.Load() {
			http.Error(w, "secret-for-test", http.StatusUnauthorized)
			return
		}
		sampleLLM(w)
	}))
	defer remote.Close()
	_, saved := f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 1, "llm_base_url": remote.URL + "/v1", "llm_model": "model", "llm_api_key": "secret-for-test"}, 200, "")
	if saved["restart_required"] != false || calls.Load() != 0 {
		t.Fatal("LLM save must be hot and must not call upstream", saved)
	}
	f.json(t, "POST", "/api/v1/admin/onboarding", map[string]any{"revision": 2, "skip_llm": true}, 400, "")
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 2, "llm_base_url": remote.URL + "/other"}, 400, "")
	fail.Store(true)
	_, failure := f.json(t, "POST", "/api/v1/admin/llm-test", map[string]any{"revision": 2}, 502, "")
	if strings.Contains(string(jsonBytes(failure)), "secret-for-test") || calls.Load() != 1 {
		t.Fatal("leak or retry")
	}
	f.json(t, "POST", "/api/v1/admin/onboarding", map[string]any{"revision": 2, "skip_llm": false}, 409, "")
	fail.Store(false)
	delay.Store(true)
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.json(t, "POST", "/api/v1/admin/llm-test", map[string]any{"revision": 2}, 409, "")
	}()
	<-entered
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 2, "llm_model": "new-model"}, 200, "")
	close(release)
	<-done
	delay.Store(false)
	_, state := f.json(t, "GET", "/api/v1/admin/onboarding", nil, 200, "")
	if state["llm_tested"] != false {
		t.Fatal("stale success approved new revision")
	}
	_, tested := f.json(t, "POST", "/api/v1/admin/llm-test", map[string]any{"revision": 3}, 200, "")
	if tested["tested"] != true || calls.Load() != 3 {
		t.Fatal(tested, calls.Load())
	}
	f.json(t, "POST", "/api/v1/admin/onboarding", map[string]any{"revision": 3, "skip_llm": false}, 200, "")
	f.json(t, "POST", "/api/v1/admin/llm-test", map[string]any{"revision": 3}, 429, "")
	_, saved = f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 3, "llm_model": "another-model"}, 200, "")
	if saved["llm_tested"] != false {
		t.Fatal("test status survived edit")
	}
	_, state = f.json(t, "GET", "/api/v1/admin/onboarding", nil, 200, "")
	if state["completed"] != true {
		t.Fatal("editing configuration reopened setup")
	}
}

// @use-case docs/feature/accounts/use-case/setup-site.md
func TestLLMQueuedSnapshotSurvivesConfigurationChange(t *testing.T) {
	f, _, tid, _ := insightFixture(t)
	var oldCalls, newCalls atomic.Int32
	old := fakeInsightServer(t, &oldCalls)
	defer old.Close()
	next := fakeInsightServer(t, &newCalls)
	defer next.Close()
	path := "/api/v1/transcriptions/" + tid + "/insights"
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 1, "llm_base_url": old.URL, "llm_api_key": "old-secret", "llm_model": "old-model"}, 200, "")
	_, queued := f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
	if strings.Contains(string(jsonBytes(queued)), "old-secret") {
		t.Fatal("snapshot leaked")
	}
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 2, "llm_base_url": next.URL, "llm_api_key": "new-secret", "llm_model": "new-model"}, 200, "")
	other := New(f.a.Config, f.db)
	work, err := other.claimInsight(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	other.executeInsight(context.Background(), work)
	if oldCalls.Load() != 1 || newCalls.Load() != 0 {
		t.Fatal("queued task did not retain original target")
	}
	f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
	work, err = other.claimInsight(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	other.executeInsight(context.Background(), work)
	if oldCalls.Load() != 1 || newCalls.Load() != 1 {
		t.Fatal("new job did not use new config")
	}
	var cleared bool
	if err := f.db.QueryRow(context.Background(), "SELECT llm_config_json IS NULL AND input_json IS NULL FROM transcription_insights WHERE transcription_id=$1", tid).Scan(&cleared); err != nil || !cleared {
		t.Fatal("terminal credentials retained", err)
	}
	for _, mode := range []string{"restore", "expiry", "disabled"} {
		f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
		switch mode {
		case "restore":
			f.a.Config.RestoreMode = true
			err = f.a.Restore(context.Background())
			f.a.Config.RestoreMode = false
		case "expiry":
			_, err = f.a.claimInsight(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			_, err = f.db.Exec(context.Background(), "UPDATE transcription_insights SET lease_until=now()-interval '1 minute'")
			f.a.claimInsight(context.Background())
		case "disabled":
			_, err = f.db.Exec(context.Background(), "UPDATE users SET status='disabled'")
			f.a.claimInsight(context.Background())
		}
		if err != nil {
			t.Fatal(err)
		}
		if err = f.db.QueryRow(context.Background(), "SELECT llm_config_json IS NULL AND input_json IS NULL FROM transcription_insights WHERE transcription_id=$1", tid).Scan(&cleared); err != nil || !cleared {
			t.Fatal(mode, "retained secret", err)
		}
	}
}

// @use-case docs/feature/accounts/use-case/setup-site.md
func TestOnboardingMigrationExistingSite(t *testing.T) {
	f, _, tid, _ := insightFixture(t)
	ctx := context.Background()
	f.json(t, "POST", "/api/v1/transcriptions/"+tid+"/insights", map[string]any{}, 202, uuid.NewString())
	// Restore the previous schema to exercise the real upgrade migration.
	_, err := f.db.Exec(ctx, `ALTER TABLE instance_settings DROP COLUMN site_setup_completed;
 ALTER TABLE server_settings DROP COLUMN llm_test_revision;
 ALTER TABLE transcription_insights DROP COLUMN llm_config_json;
 DELETE FROM schema_migrations WHERE name='013_site_onboarding.sql';`)
	if err != nil {
		t.Fatal(err)
	}
	if err = persistence.Migrate(ctx, f.db); err != nil {
		t.Fatal(err)
	}
	_, state := f.json(t, "GET", "/api/v1/auth/status", nil, 200, "")
	if state["site_setup_completed"] != true {
		t.Fatal("upgrade locked existing site")
	}
	var code string
	var cleared bool
	if err = f.db.QueryRow(ctx, "SELECT error_code,input_json IS NULL AND llm_config_json IS NULL FROM transcription_insights WHERE transcription_id=$1", tid).Scan(&code, &cleared); err != nil || code != "interrupted" || !cleared {
		t.Fatal("old work replay risk", err)
	}
}

// @use-case docs/feature/accounts/use-case/setup-site.md
func TestOnboardingBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	for _, scenario := range []struct {
		name, title string
		calls       int32
	}{
		{"main", "管理员注册后独立初始化、恢复草稿、测试失败修正和普通用户分流", 2},
		{"revision", "配置修改使测试失效，旧测试结果不能批准新配置", 3},
		{"skip", "清空配置后跳过，完成失败可重试且完成后不再初始化", 0},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			// 每个浏览器场景都有全新的数据库 schema，不依赖前一场景的完成状态。
			f := setupAccountFixture(t, false)
			f.a.Config.WebDir = "../../web/dist"
			var calls atomic.Int32
			var waiting atomic.Bool
			release := make(chan struct{})
			var releaseOnce sync.Once
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/models":
					writeJSON(w, 200, map[string]any{"data": []any{map[string]any{"id": "sample-model"}}})
					return
				case "/test/status":
					writeJSON(w, 200, map[string]any{"waiting": waiting.Load()})
					return
				case "/test/release":
					releaseOnce.Do(func() { close(release) })
					w.WriteHeader(http.StatusNoContent)
					return
				}
				calls.Add(1)
				var body struct {
					Model string `json:"model"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					http.Error(w, "invalid request", 400)
					return
				}
				if body.Model == "invalid-model" {
					http.Error(w, "private provider response", 401)
					return
				}
				if body.Model == "delayed-model" {
					waiting.Store(true)
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
				}
				sampleLLM(w)
			}))
			defer func() { releaseOnce.Do(func() { close(release) }); remote.Close() }()
			ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
			defer cancel()
			cmd := exec.CommandContext(ctx, "vp", "exec", "e2e", "run", "tests/onboarding.e2e.ts", "--grep", "^"+scenario.title+"$")
			cmd.Dir = "../../web"
			cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_E2E_OUTPUT=.e2e/onboarding/"+scenario.name, "VOICES_TEST_URL="+f.server.URL, "VOICES_MODEL_TEST_URL="+remote.URL)
			output, err := cmd.CombinedOutput()
			t.Log(string(output))
			if err != nil {
				t.Fatal(err)
			}
			if calls.Load() != scenario.calls {
				t.Fatal("unexpected generation count", calls.Load())
			}
		})
	}
}

// @use-case docs/feature/accounts/use-case/setup-site.md
func TestDeploymentWithoutDotenvOrLLMCredentials(t *testing.T) {
	f := setupAccountFixture(t, false)
	t.Chdir(t.TempDir())
	t.Setenv("DATABASE_URL", "postgres://127.0.0.1/unused-config-validation")
	for _, name := range []string{"DATABASE_URL_FILE", "PUBLIC_BASE_URL", "ALLOWED_ORIGINS", "SONIOX_API_KEY", "SONIOX_API_KEY_FILE", "ASSEMBLYAI_API_KEY", "ASSEMBLYAI_API_KEY_FILE", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_API_KEY_FILE"} {
		t.Setenv(name, "")
	}
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Exec(context.Background(), "DELETE FROM server_settings"); err != nil {
		t.Fatal(err)
	}
	a, err := NewServer(context.Background(), c, f.db)
	if err != nil {
		t.Fatal(err)
	}
	if a.Config.LLMBaseURL != "" || a.Config.LLMModel != "" || a.Config.LLMKey != "" {
		t.Fatal("unexpected LLM requirement or credentials")
	}
	t.Setenv("DATABASE_URL", "")
	if _, err = LoadConfig(); err == nil {
		t.Fatal("database connection must remain required")
	}
}
