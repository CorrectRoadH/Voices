package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestAutomaticInsightsBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	stt := fakeRemote(t)
	f := setup(t)
	llm := configureAutomaticInsights(t, f, false)
	f.json(t, "PATCH", "/api/v1/settings", map[string]any{"default_transcription": options()}, 200, "")
	f.a.Config.WebDir = "../../web/dist"
	audio := filepath.Join(t.TempDir(), "automatic-meeting.wav")
	if err := os.WriteFile(audio, wav(20), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); f.a.Run(ctx) }()
	defer func() { cancel(); <-done }()
	cmdCtx, stop := context.WithTimeout(context.Background(), 3*time.Minute)
	defer stop()
	cmd := exec.CommandContext(cmdCtx, "vp", "exec", "node", "tests/automatic-insights.browser.mjs")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "VOICES_TEST_URL="+f.server.URL, "VOICES_TEST_AUDIO="+audio)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	if stt.submits.Load() != 1 || llm.Load() != 1 {
		t.Fatalf("unexpected calls: STT=%d LLM=%d", stt.submits.Load(), llm.Load())
	}
}
