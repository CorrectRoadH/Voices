package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	fakeRemote(t)
	f := setup(t)
	f.a.Config.WebDir = "../../web/dist"
	gate := filepath.Join(t.TempDir(), "allow-inference")
	var hold atomic.Bool
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serveVoiceprint(t, f, func(callCtx context.Context, pcm []byte) ([]float64, error) {
		if hold.Load() {
			ticker := time.NewTicker(50 * time.Millisecond)
			defer ticker.Stop()
			for {
				if _, err := os.Stat(gate); err == nil {
					break
				}
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-callCtx.Done():
					return nil, callCtx.Err()
				case <-ticker.C:
				}
			}
		}
		return voiceprintResponse(pcm, 0)
	})
	_, _, label := voiceprintRecording(t, f, 20)
	_, person := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "声纹测试人物"}, 201, uuid.NewString())
	pid := person["id"].(string)
	assignVoiceprint(t, f, label, pid)
	runVoiceprint(t, f)
	rid, tid, _ := voiceprintRecording(t, f, 21)
	hold.Store(true)
	done := make(chan struct{})
	go func() { defer close(done); f.a.Run(ctx) }()
	defer func() { cancel(); <-done }()
	cmdCtx, stop := context.WithTimeout(ctx, 3*time.Minute)
	defer stop()
	cmd := exec.CommandContext(cmdCtx, "vp", "exec", "e2e", "run", "--config", "e2e.voiceprints.config.ts")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "VOICES_TEST_URL="+f.server.URL, "VOICES_TEST_RECORDING="+rid, "VOICES_TEST_TRANSCRIPTION="+tid, "VOICES_TEST_PERSON="+pid, "VOICES_TEST_VOICEPRINT_GATE="+gate, "E2E_TELEMETRY_DISABLED=1")
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}
