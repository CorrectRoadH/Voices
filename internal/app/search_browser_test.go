package app

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/google/uuid"
)

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestTranscriptSearchBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	fakeRemote(t)
	f := setup(t)
	f.a.Config.WebDir = "../../web/dist"
	out := f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	job := f.run(t, "transcribe")
	tid := *job.TranscriptionID
	// A late-page phrase repeated in one segment counts as one matching segment.
	_, err := f.db.Exec(context.Background(), `UPDATE segments SET source_text='自动思维 Auto.[ 自动思维' WHERE transcription_id=$1 AND ordinal IN (80,110)`, tid)
	if err != nil {
		t.Fatal(err)
	}
	var target string
	if err := f.db.QueryRow(context.Background(), `SELECT id FROM segments WHERE transcription_id=$1 AND ordinal=110`, tid).Scan(&target); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "vp", "exec", "e2e", "run", "tests/search.e2e.ts")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_E2E_OUTPUT=.e2e/search", "VOICES_TEST_URL="+f.server.URL, "VOICES_SEARCH_PATH=/recordings/"+rid+"/transcriptions/"+tid, "VOICES_SEARCH_TARGET="+target)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}
