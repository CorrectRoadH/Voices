package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/google/uuid"
	"voices/internal/insights"
)

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestTranscriptNavigationBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	f, rid, tid, ids := referenceFixture(t)
	f.a.Config.WebDir = "../../web/dist"
	f.a.Config.LLMBaseURL = "http://127.0.0.1:1/v1"
	f.a.Config.LLMModel = "test-model"
	seedFixtureSettings(t, f)
	result := insights.Result{Summary: "导航回归", Chapters: []insights.Chapter{{SegmentID: ids[0], Title: "开场"}, {SegmentID: ids[10], Title: "已加载章节"}, {SegmentID: ids[80], Title: "中间章节"}, {SegmentID: ids[110], Title: "远处章节"}}}
	if _, err := f.db.Exec(context.Background(), `INSERT INTO transcription_insights(transcription_id,generation,state,source_hash,result_json,model) VALUES($1,$2,'succeeded','test',$3,'test')`, tid, uuid.NewString(), jsonBytes(result)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "vp", "exec", "e2e", "run", "tests/navigation.e2e.ts")
	cmd.Dir = "../../web"
	data, _ := json.Marshal(ids)
	cmd.Env = append(os.Environ(), "VOICES_TEST_URL="+f.server.URL, "VOICES_NAV_PATH=/recordings/"+rid+"/transcriptions/"+tid, "VOICES_NAV_IDS="+string(data), "VOICES_E2E_OUTPUT=.e2e/navigation", "E2E_TELEMETRY_DISABLED=1")
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}
