package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

func seedFixtureSettings(t *testing.T, f *fixture) {
	t.Helper()
	if _, err := f.db.Exec(context.Background(), `INSERT INTO server_settings(id,value_json) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET value_json=EXCLUDED.value_json,llm_test_revision=NULL`, jsonBytes(settingsFromConfig(f.a.Config))); err != nil {
		t.Fatal(err)
	}
	c, err := LoadServerConfig(context.Background(), f.db, f.a.Config)
	if err != nil {
		t.Fatal(err)
	}
	f.a.Config = c
}

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestServerSettingsDatabasePriority(t *testing.T) {
	f := setup(t)
	if _, err := f.db.Exec(context.Background(), "DELETE FROM server_settings"); err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	if err := os.WriteFile(".env", []byte("DATABASE_URL=postgres://localhost/example\nPUBLIC_BASE_URL=https://seed.example/voices/\nSONIOX_API_KEY=dotenv-secret\nLLM_BASE_URL=http://localhost:11434/v1\nLLM_MODEL=local-model\n"), 0600); err != nil {
		t.Fatal(err)
	}
	// Existing process values beat .env only during initial import.
	t.Setenv("SONIOX_API_KEY", "process-secret")
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	c, err = LoadServerConfig(context.Background(), f.db, c)
	if err != nil {
		t.Fatal(err)
	}
	if c.SonioxKey != "process-secret" || c.PublicBaseURL != "https://seed.example/voices" || c.LLMModel != "local-model" {
		t.Fatal("first-start import incorrect")
	}
	// Empty values are intentional, not a reason to consult stale env/_FILE.
	_, err = f.db.Exec(context.Background(), `UPDATE server_settings SET value_json=jsonb_set(value_json,'{soniox_api_key}','""') WHERE id=1`)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PUBLIC_BASE_URL", "invalid-old-value")
	t.Setenv("ALLOWED_ORIGINS", "*")
	t.Setenv("SONIOX_API_KEY_FILE", "/does-not-exist")
	next, err := LoadConfig()
	if err != nil {
		t.Fatal("business seeds must not block database configuration", err)
	}
	a, err := NewServer(context.Background(), next, f.db)
	if err != nil {
		t.Fatal(err)
	}
	if a.Config.SonioxKey != "" || a.Config.PublicBaseURL != "https://seed.example/voices" || a.Config.LLMModel != "local-model" {
		t.Fatal("database did not win")
	}
}

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestServerSettingsConcurrentBootstrap(t *testing.T) {
	f := setup(t)
	if _, err := f.db.Exec(context.Background(), "DELETE FROM server_settings"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan Config, 4)
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := f.a.Config
			c.PublicBaseURL = fmt.Sprintf("https://candidate%d.example", i)
			c, err := LoadServerConfig(context.Background(), f.db, c)
			if err != nil {
				errs <- err
				return
			}
			results <- c
		}(i)
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	winner := ""
	for c := range results {
		if winner == "" {
			winner = c.PublicBaseURL
		}
		if c.PublicBaseURL != winner {
			t.Fatal("bootstrap produced multiple winners")
		}
	}
	var count int
	if err := f.db.QueryRow(context.Background(), "SELECT count(*) FROM server_settings").Scan(&count); err != nil || count != 1 {
		t.Fatal("expected one configuration row", err)
	}
}

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestAdminServerSettings(t *testing.T) {
	f := setup(t)
	seedFixtureSettings(t, f)
	_, saved := f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 1, "llm_api_key": "llm-private-value", "soniox_api_key": "stt-private-value", "llm_base_url": "https://llm.example/v1", "llm_model": "model-id"}, 200, "")
	if saved["restart_required"] != true || saved["revision"] != float64(2) {
		t.Fatal("missing pending state")
	}
	if strings.Contains(string(jsonBytes(saved)), "private-value") || strings.Contains(string(jsonBytes(saved)), "test-only-key") {
		t.Fatal("response leaked secret")
	}
	if f.a.Config.SonioxKey != "test-only-key" {
		t.Fatal("save mutated live process")
	}
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 1, "llm_model": "stale"}, 409, "")
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 2, "llm_model": "new-model"}, 200, "")
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 3, "llm_api_key": ""}, 200, "")
	next, err := NewServer(context.Background(), f.a.Config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	if next.Config.LLMKey != "" || next.Config.SonioxKey != "stt-private-value" || next.Config.LLMModel != "new-model" {
		t.Fatal("restart did not load saved settings")
	}
	var details []byte
	if err := f.db.QueryRow(context.Background(), "SELECT jsonb_agg(details) FROM admin_audit_events WHERE action='server_settings_updated'").Scan(&details); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(details), "private-value") || strings.Contains(string(details), "model-id") || !strings.Contains(string(details), "soniox_api_key") {
		t.Fatal("audit should contain field names only")
	}
	for _, patch := range []map[string]any{
		{"public_base_url": "https://user:secret@example.com"}, {"public_base_url": "https://example.com/a/../b"}, {"public_base_url": "https://example.com?"},
		{"public_base_url": "https://example.com:99999"}, {"llm_base_url": "javascript:bad"}, {"allowed_origins": []string{"https://*.example"}},
		{"allowed_origins": []string{"https://example/path"}}, {"llm_api_key": nil}, {"llm_model": "bad\nvalue"}, {"unknown": "value"}, {"soniox_api_key": 42},
	} {
		patch["revision"] = 4
		f.json(t, "PATCH", "/api/v1/admin/server-settings", patch, 400, "")
	}
	oldCSRF := f.csrf
	f.csrf = "bad"
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 4, "llm_model": "rejected"}, 403, "")
	f.csrf = oldCSRF
	f.a.Config.RestoreMode = true
	f.json(t, "GET", "/api/v1/admin/server-settings", nil, 200, "")
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 4, "llm_model": "rejected"}, 409, "")
	f.a.Config.RestoreMode = false
	_, user := f.json(t, "POST", "/api/v1/users", map[string]any{"email": "other@example.test", "display_name": "Other", "password": "test-password"}, 201, "")
	f.csrf = user["csrf_token"].(string)
	f.json(t, "GET", "/api/v1/admin/server-settings", nil, 403, "")
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 4, "llm_model": "rejected"}, 403, "")
}

type configurationTransport struct {
	target *url.URL
	base   http.RoundTripper
}

func (r configurationTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host != "api.soniox.com" && req.URL.Host != "api.assemblyai.com" {
		return r.base.RoundTrip(req)
	}
	copy := req.Clone(req.Context())
	u := *req.URL
	u.Scheme, u.Host = r.target.Scheme, r.target.Host
	copy.URL = &u
	return r.base.RoundTrip(copy)
}

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestServerSettingsSTTCredentialsAndHealth(t *testing.T) {
	f := setup(t)
	seedFixtureSettings(t, f)
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 1, "soniox_api_key": "database-soniox", "assemblyai_api_key": "database-assembly", "public_base_url": "https://voices.example/prefix"}, 200, "")
	seen := make(chan string, 2)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("Authorization")
		if r.URL.Path == "/v1/files" {
			writeJSON(w, 200, map[string]string{"id": "file-id"})
		} else {
			writeJSON(w, 200, map[string]string{"upload_url": "https://cdn.assemblyai.com/upload/test"})
		}
	}))
	defer remote.Close()
	target, _ := url.Parse(remote.URL)
	old := http.DefaultTransport
	http.DefaultTransport = configurationTransport{target, old}
	t.Cleanup(func() { http.DefaultTransport = old })
	a, err := NewServer(context.Background(), f.a.Config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"soniox", "assemblyai"} {
		if _, err := a.Providers[id].Upload(context.Background(), bytes.NewReader([]byte("audio")), "test.wav", 5); err != nil {
			t.Fatal(id, err)
		}
	}
	if <-seen != "Bearer database-soniox" || <-seen != "database-assembly" {
		t.Fatal("STT adapter did not use database credentials")
	}
	for _, path := range []string{"/healthz", "/prefix/healthz"} {
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 {
			t.Fatal("health check failed", path, w.Code)
		}
	}
}

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestServerSettingsBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	f := setupAccountFixture(t, false)
	seedFixtureSettings(t, f)
	f.a.Config.WebDir = "../../web/dist"
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "vp", "exec", "e2e", "run", "tests/settings.e2e.ts")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_E2E_OUTPUT=.e2e/settings", "VOICES_TEST_URL="+f.server.URL)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err := f.db.QueryRow(context.Background(), "SELECT value_json FROM server_settings WHERE id=1").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var s ServerSettings
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	if s.SonioxKey != "" || s.AssemblyAIKey != "browser-assembly-key" || s.LLMKey != "browser-llm-key" || s.LLMModel != "browser-model" {
		t.Fatal("browser did not persist intended settings")
	}
}

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestAdminServerSettingsConcurrentEdits(t *testing.T) {
	f := setup(t)
	seedFixtureSettings(t, f)
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, model := range []string{"first", "second"} {
		wg.Add(1)
		go func(model string) {
			defer wg.Done()
			req, err := http.NewRequest("PATCH", f.server.URL+"/api/v1/admin/server-settings", bytes.NewReader(jsonBytes(map[string]any{"revision": 1, "llm_model": model})))
			if err != nil {
				t.Error(err)
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-CSRF-Token", f.csrf)
			res, err := f.client.Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			defer res.Body.Close()
			statuses <- res.StatusCode
		}(model)
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatal("concurrent save must have one winner", counts)
	}
	var revision, auditCount int
	if err := f.db.QueryRow(context.Background(), "SELECT revision FROM server_settings WHERE id=1").Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(context.Background(), "SELECT count(*) FROM admin_audit_events WHERE action='server_settings_updated'").Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if revision != 2 || auditCount != 1 {
		t.Fatal("save and audit were not atomic")
	}
}
