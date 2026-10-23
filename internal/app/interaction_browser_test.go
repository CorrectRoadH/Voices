package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
)

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestInteractionBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	remote := fakeRemote(t)
	f := setup(t)
	f.a.Config.WebDir = "../../web/dist"
	other := anotherAccount(t, f, "ui_reviewer")
	for range 51 {
		_, err := f.db.Exec(context.Background(), `INSERT INTO external_calls(id,owner_id,category,operation,provider,model,deadline_at,state,request_started,http_status) VALUES($1,$2,'stt','upload','soniox','ui-pagination',clock_timestamp(),'succeeded',true,200)`, uuid.NewString(), userID(t, f))
		if err != nil {
			t.Fatal(err)
		}
	}
	out := f.upload(t, wav(20), map[string]any{"title": "加载与编辑验收", "auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	id := out["recording"].(map[string]any)["id"].(string)
	for range 3 {
		_, err := f.db.Exec(context.Background(), `INSERT INTO external_calls(id,owner_id,category,operation,provider,model,recording_id,job_id,deadline_at,state,request_started,http_status,audio_duration_ms) VALUES($1,$2,'stt','poll','soniox','ui-fold',$3,$3,clock_timestamp(),'succeeded',true,200,5162000)`, uuid.NewString(), userID(t, f), id)
		if err != nil {
			t.Fatal(err)
		}
	}
	gate := filepath.Join(t.TempDir(), "start-worker")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := os.Stat(gate); err == nil {
					f.a.Run(ctx)
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-done }()
	cmdCtx, stop := context.WithTimeout(context.Background(), 3*time.Minute)
	defer stop()
	cmd := exec.CommandContext(cmdCtx, "vp", "exec", "e2e", "run", "--config", "e2e.interaction.config.ts")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_TEST_URL="+f.server.URL, "VOICES_TEST_RECORDING="+id, "VOICES_TEST_WORKER_GATE="+gate)
	cmd.Env = append(cmd.Env, "VOICES_TEST_UI_USER="+userID(t, other))
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	if remote.uploads.Load() != 2 || remote.submits.Load() != 2 {
		t.Fatalf("unexpected remote operations: uploads=%d submits=%d", remote.uploads.Load(), remote.submits.Load())
	}
}
