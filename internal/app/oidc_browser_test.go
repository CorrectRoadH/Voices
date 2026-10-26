package app

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// @use-case docs/feature/accounts/use-case/oidc-login.md
func TestOIDCBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	f := setup(t)
	p := newFakeOIDC(t)
	// Different sites, not just ports: this verifies Lax callback binding and
	// recovery of the existing Strict session after the browser lands on the SPA.
	p.server.URL = strings.Replace(p.server.URL, "127.0.0.1", "localhost", 1)
	f.a.Config.WebDir = "../../web/dist"
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "vp", "exec", "e2e", "run", "--config", "e2e.oidc.config.ts")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_TEST_URL="+f.server.URL, "VOICES_TEST_ISSUER="+p.server.URL)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.db.QueryRow(context.Background(), "SELECT count(*) FROM users WHERE role='user' AND password_hash IS NOT NULL").Scan(&count); err != nil || count != 1 {
		t.Fatal("browser did not complete password recovery", count, err)
	}
}
