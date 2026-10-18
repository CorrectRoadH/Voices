package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
func TestBrowserFullStack(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web for real full-stack browser acceptance")
	}
	remote := fakeRemote(t)
	f := setup(t)
	f.a.Config.WebDir = "../../web/dist"
	path := filepath.Join(t.TempDir(), "browser-meeting.wav")
	if err := os.WriteFile(path, wav(20), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); f.a.Run(ctx) }()
	defer func() { cancel(); <-done }()
	cmdCtx, cmdCancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cmdCancel()
	cmd := exec.CommandContext(cmdCtx, "node", "../../web/scripts/full-stack.mjs")
	cmd.Env = append(os.Environ(), "VOICES_TEST_URL="+f.server.URL, "VOICES_TEST_AUDIO="+path)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	if remote.uploads.Load() != 1 || remote.submits.Load() != 1 {
		t.Fatalf("unexpected remote operations: uploads=%d submits=%d", remote.uploads.Load(), remote.submits.Load())
	}
}

// @feature docs/feature/accounts/README.md
func TestAccountsBrowserFullStack(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	f := setupAccountFixture(t, false)
	f.a.Config.PublicBaseURL = "http://configured.example.invalid"
	f.a.Config.AllowedOrigins = []string{f.server.URL}
	f.a.Config.WebDir = "../../web/dist"
	path := filepath.Join(t.TempDir(), "accounts-meeting.wav")
	if err := os.WriteFile(path, wav(2), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); f.a.Run(ctx) }()
	defer func() { cancel(); <-done }()
	cmdCtx, stop := context.WithTimeout(context.Background(), 90*time.Second)
	defer stop()
	cmd := exec.CommandContext(cmdCtx, "node", "../../web/scripts/accounts-stack.mjs")
	cmd.Env = append(os.Environ(), "VOICES_TEST_URL="+f.server.URL, "VOICES_TEST_AUDIO="+path)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}
