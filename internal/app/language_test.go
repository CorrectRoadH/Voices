package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"
)

// @use-case docs/feature/interface-language/use-case/choose-language.md
func TestRegistrationLanguageValidation(t *testing.T) {
	f := setupAccountFixture(t, false)
	for _, language := range []any{"fr", nil, ""} {
		_, result := f.json(t, "POST", "/api/v1/users", map[string]any{"email": "invalid@example.test", "display_name": "Invalid", "password": "acceptance-password", "ui_language": language}, 400, "")
		if result["error"].(map[string]any)["code"] != "invalid_ui_language" {
			t.Fatal(result)
		}
	}
	_, english := f.json(t, "POST", "/api/v1/users", map[string]any{"email": "english@example.test", "display_name": "English", "password": "acceptance-password", "ui_language": "en"}, 201, "")
	if english["user"].(map[string]any)["ui_language"] != "en" {
		t.Fatal(english)
	}
	_, defaults := f.json(t, "POST", "/api/v1/users", map[string]any{"email": "default@example.test", "display_name": "Default", "password": "acceptance-password"}, 201, "")
	if defaults["user"].(map[string]any)["ui_language"] != "zh-CN" {
		t.Fatal(defaults)
	}
}

// @use-case docs/feature/interface-language/use-case/choose-language.md
func TestAccountLanguageIsolationAndUpdates(t *testing.T) {
	f := setup(t)
	b := anotherAccount(t, f, "LanguageOther")
	_, session := f.json(t, "GET", "/api/v1/session", nil, 200, "")
	initial := session["user"].(map[string]any)
	if initial["ui_language"] != "zh-CN" {
		t.Fatal(initial)
	}
	_, changed := f.json(t, "PATCH", "/api/v1/me", map[string]any{"ui_language": "en"}, 200, "")
	if changed["ui_language"] != "en" || changed["display_name"] != initial["display_name"] || changed["username"] != initial["username"] {
		t.Fatal(changed)
	}
	_, other := b.json(t, "GET", "/api/v1/session", nil, 200, "")
	if other["user"].(map[string]any)["ui_language"] != "zh-CN" {
		t.Fatal("language leaked", other)
	}
	for _, invalid := range []any{"fr", "", "EN", nil, 7, true} {
		_, result := f.json(t, "PATCH", "/api/v1/me", map[string]any{"ui_language": invalid}, 400, "")
		if result["error"].(map[string]any)["code"] != "invalid_ui_language" {
			t.Fatal(result)
		}
	}
	f.json(t, "PATCH", "/api/v1/me", map[string]any{}, 400, "")
	f.json(t, "PATCH", "/api/v1/me", map[string]any{"display_name": nil}, 400, "")
	_, profile := f.json(t, "PATCH", "/api/v1/me", map[string]any{"display_name": "中文姓名", "username": "language_user"}, 200, "")
	if profile["ui_language"] != "en" {
		t.Fatal(profile)
	}
	// Separate fields can be updated concurrently without reverting either value.
	var wg sync.WaitGroup
	failures := make(chan error, 2)
	for _, patch := range []map[string]any{{"ui_language": "zh-CN"}, {"display_name": "Concurrent name"}} {
		wg.Add(1)
		go func(patch map[string]any) {
			defer wg.Done()
			req, err := http.NewRequest("PATCH", f.server.URL+"/api/v1/me", bytes.NewReader(jsonBytes(patch)))
			if err != nil {
				failures <- err
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-CSRF-Token", f.csrf)
			res, err := f.client.Do(req)
			if err != nil {
				failures <- err
				return
			}
			defer res.Body.Close()
			if res.StatusCode != 200 {
				failures <- fmt.Errorf("update status %d", res.StatusCode)
			}
		}(patch)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	_, session = f.json(t, "GET", "/api/v1/session", nil, 200, "")
	user := session["user"].(map[string]any)
	if user["ui_language"] != "zh-CN" || user["display_name"] != "Concurrent name" || user["username"] != "language_user" {
		t.Fatal(user)
	}
	f.json(t, "PATCH", "/api/v1/me", map[string]any{"ui_language": "en"}, 200, "")
	_, users := f.json(t, "GET", "/api/v1/admin/users", nil, 200, "")
	found := false
	for _, raw := range users["items"].([]any) {
		u := raw.(map[string]any)
		if u["id"] == initial["id"] {
			found = true
			if u["ui_language"] != "en" {
				t.Fatal(u)
			}
		}
	}
	if !found {
		t.Fatal("current user missing from admin list")
	}
	f.json(t, "DELETE", "/api/v1/session", nil, 204, "")
	_, loggedIn := f.json(t, "POST", "/api/v1/session", map[string]any{"identifier": "language_user", "password": "acceptance-password"}, 200, "")
	f.csrf = loggedIn["csrf_token"].(string)
	if loggedIn["user"].(map[string]any)["ui_language"] != "en" {
		t.Fatal(loggedIn)
	}
	// Enforce database validation even when a write bypasses the HTTP handler.
	if _, err := f.db.Exec(context.Background(), "UPDATE users SET ui_language='fr' WHERE id=$1", initial["id"]); err == nil {
		t.Fatal("missing language constraint")
	}
	savedCSRF := f.csrf
	f.csrf = "invalid"
	f.json(t, "PATCH", "/api/v1/me", map[string]any{"ui_language": "zh-CN"}, 403, "")
	f.csrf = savedCSRF
	cfg := f.a.Config
	cfg.RestoreMode = true
	recovery := httptest.NewServer(New(cfg, f.db).Handler())
	defer recovery.Close()
	restore := &fixture{a: f.a, db: f.db, server: recovery, client: f.client, csrf: f.csrf}
	restore.json(t, "PATCH", "/api/v1/me", map[string]any{"ui_language": "zh-CN"}, 409, "")
}

// @use-case docs/feature/interface-language/use-case/choose-language.md
func TestInterfaceLanguageBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	f := setupAccountFixture(t, false)
	seedFixtureSettings(t, f)
	f.a.Config.WebDir = "../../web/dist"
	models := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("private upstream response"))
	}))
	defer models.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "../../web/scripts/language-stack.mjs")
	cmd.Env = append(os.Environ(), "VOICES_TEST_URL="+f.server.URL, "VOICES_MODEL_TEST_URL="+models.URL)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err := f.db.QueryRow(context.Background(), "SELECT row_to_json(u) FROM users u WHERE email='language-admin@example.test'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var user User
	if err := json.Unmarshal(raw, &user); err != nil {
		t.Fatal(err)
	}
	if user.UILanguage != "en" || user.DisplayName != "中文用户名" {
		t.Fatalf("persisted user mismatch: %+v", user)
	}
}
