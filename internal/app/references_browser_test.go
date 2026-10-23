package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"
)

// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
func TestReferencesBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	f, rid, tid, ids := referenceFixture(t)
	f.a.Config.WebDir = "../../web/dist"
	// A fully visible speaker group, with a deliberately discontinuous later selection.
	_, err := f.db.Exec(context.Background(), `UPDATE segments SET source_speaker_label_id=(SELECT source_speaker_label_id FROM segments WHERE id=$1) WHERE transcription_id=$2 AND ordinal<4`, ids[0], tid)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.Exec(context.Background(), `UPDATE segments SET source_text='原文 [括号] *星号* <标签> &amp;' WHERE id=$1`, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "vp", "exec", "e2e", "run", "tests/references.e2e.ts")
	cmd.Dir = "../../web"
	data, _ := json.Marshal(ids)
	cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_E2E_OUTPUT=.e2e/references", "VOICES_TEST_URL="+f.server.URL,
		"VOICES_REFERENCE_PATH=/recordings/"+rid+"/transcriptions/"+tid, "VOICES_REFERENCE_IDS="+string(data), "VOICES_REFERENCE_TID="+tid)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}
