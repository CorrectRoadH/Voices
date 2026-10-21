package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestAdminLLMModelsCredentialsAndPermissions(t *testing.T) {
	f := setup(t)
	seedFixtureSettings(t, f)
	var calls atomic.Int32
	auth := make(chan string, 8)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		auth <- r.Header.Get("Authorization")
		if r.Method != "GET" || r.URL.Path != "/v1/models" {
			t.Error("unexpected remote operation")
		}
		writeJSON(w, 200, map[string]any{"data": []any{map[string]string{"id": "test-model"}}})
	}))
	defer remote.Close()
	f.json(t, "PATCH", "/api/v1/admin/server-settings", map[string]any{"revision": 1, "llm_base_url": remote.URL + "/v1", "llm_api_key": "saved-private-key"}, 200, "")
	path := "/api/v1/admin/llm-models"
	input := map[string]any{"revision": 2, "base_url": remote.URL + "/v1/"}
	_, result := f.json(t, "POST", path, input, 200, "")
	if <-auth != "Bearer saved-private-key" || strings.Contains(string(jsonBytes(result)), "private-key") {
		t.Fatal("credential isolation failed")
	}
	input["api_key"] = "new-private-key"
	f.json(t, "POST", path, input, 200, "")
	if <-auth != "Bearer new-private-key" {
		t.Fatal("draft key unused")
	}
	input["api_key"] = ""
	f.json(t, "POST", path, input, 200, "")
	if <-auth != "" {
		t.Fatal("empty key must not fall back")
	}
	delete(input, "api_key")
	input["base_url"] = "http://127.0.0.1:1/v1"
	_, blocked := f.json(t, "POST", path, input, 400, "")
	if blocked["error"].(map[string]any)["code"] != "saved_key_target_changed" {
		t.Fatal(blocked)
	}
	input["base_url"] = remote.URL + "/v1"
	input["revision"] = 1
	f.json(t, "POST", path, input, 409, "")
	input["revision"] = 2
	for _, key := range []any{nil, 23, "bad\nkey"} {
		input["api_key"] = key
		f.json(t, "POST", path, input, 400, "")
	}
	delete(input, "api_key")
	csrf := f.csrf
	f.csrf = "bad"
	f.json(t, "POST", path, input, 403, "")
	f.csrf = csrf
	f.a.Config.RestoreMode = true
	f.json(t, "POST", path, input, 409, "")
	f.a.Config.RestoreMode = false
	other := anotherAccount(t, f, "model-list-user")
	other.json(t, "POST", path, input, 403, "")
	if calls.Load() != 3 {
		t.Fatal("rejected requests reached upstream", calls.Load())
	}
	var revision int64
	var raw []byte
	if err := f.db.QueryRow(context.Background(), "SELECT revision,value_json FROM server_settings WHERE id=1").Scan(&revision, &raw); err != nil {
		t.Fatal(err)
	}
	var saved ServerSettings
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if revision != 2 || saved.LLMKey != "saved-private-key" || saved.LLMModel != "" {
		t.Fatal("discovery mutated saved config")
	}
}

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestAdminLLMModelsErrorsAreSanitized(t *testing.T) {
	f := setup(t)
	seedFixtureSettings(t, f)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte("provider body private-key"))
	}))
	defer remote.Close()
	_, result := f.json(t, "POST", "/api/v1/admin/llm-models", map[string]any{"revision": 1, "base_url": remote.URL, "api_key": "private-key"}, 502, "")
	if result["error"].(map[string]any)["code"] != "model_list_unauthorized" || strings.Contains(string(jsonBytes(result)), "private-key") {
		t.Fatal("upstream details leaked")
	}
}

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestLLMModelsBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	var calls atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/models") {
			t.Error("model discovery invoked inference or a write endpoint")
		}
		if r.Header.Get("Authorization") != "Bearer browser-model-key" {
			t.Error("wrong browser model credential")
		}
		switch r.URL.Path {
		case "/empty/models":
			writeJSON(w, 200, map[string]any{"data": []any{}})
		case "/error/models":
			w.WriteHeader(401)
			w.Write([]byte("private upstream response browser-model-key"))
		case "/slow/models":
			select {
			case <-r.Context().Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
			writeJSON(w, 200, map[string]any{"data": []any{map[string]string{"id": "obsolete-model"}}})
		default:
			writeJSON(w, 200, map[string]any{"data": []any{map[string]string{"id": "beta-model"}, map[string]string{"id": "alpha-model"}, map[string]string{"id": "alpha-model"}}})
		}
	}))
	defer remote.Close()
	f := setupAccountFixture(t, false)
	if _, err := f.db.Exec(context.Background(), "UPDATE instance_settings SET site_setup_completed=true WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	f.a.Config.LLMBaseURL, f.a.Config.LLMKey = remote.URL+"/v1", "browser-model-key"
	seedFixtureSettings(t, f)
	f.a.Config.WebDir = "../../web/dist"
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pnpm", "exec", "e2e", "run", "tests/models.e2e.ts")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_E2E_OUTPUT=.e2e/models", "VOICES_TEST_URL="+f.server.URL, "VOICES_MODEL_TEST_URL="+remote.URL)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() < 5 {
		t.Fatal("browser did not reach model service")
	}
	var raw []byte
	if err := f.db.QueryRow(context.Background(), "SELECT value_json FROM server_settings WHERE id=1").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var saved ServerSettings
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.LLMModel != "beta-model" || saved.LLMKey != "browser-model-key" {
		t.Fatal("model selection or saved key lost")
	}
}
