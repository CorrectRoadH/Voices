package app

import (
	"context"
	"github.com/google/uuid"
	"os"
	"os/exec"
	"testing"
	"time"
)

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestJobRecoveryBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	remote := fakeRemote(t)
	f := setup(t)
	f.a.Config.WebDir = "../../web/dist"
	remote.uploadStatus.Store(503)
	out := f.upload(t, wav(20), map[string]any{"title": "待确认恢复验收", "auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	j, err := f.a.claim(context.Background(), "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	f.a.execute(context.Background(), j)
	remote.uploadStatus.Store(401)
	failed := f.upload(t, wav(21), map[string]any{"title": "安全重试验收", "auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	failedID := failed["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	fj, err := f.a.claim(context.Background(), "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	f.a.execute(context.Background(), fj)
	remote.uploadStatus.Store(0)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "vp", "exec", "e2e", "run", "--config", "e2e.recovery.config.ts")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_TEST_URL="+f.server.URL, "VOICES_TEST_RECORDING="+rid, "VOICES_TEST_FAILED_RECORDING="+failedID, "VOICES_TEST_JOB="+j.ID)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	// No worker runs during browser interaction: confirmation queues one independent version.
	var count int
	if err := f.db.QueryRow(context.Background(), "SELECT count(*) FROM transcriptions WHERE recording_id=$1", rid).Scan(&count); err != nil || count != 2 {
		t.Fatalf("versions=%d err=%v", count, err)
	}
	var state string
	f.db.QueryRow(context.Background(), "SELECT state FROM jobs WHERE id=$1", j.ID).Scan(&state)
	if state != "uncertain" || remote.uploads.Load() != 2 || remote.submits.Load() != 0 {
		t.Fatal("old operation was replayed")
	}
}
