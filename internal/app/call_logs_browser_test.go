package app

import (
	"context"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
	"time"
)

// @use-case docs/feature/call-logs/use-case/inspect-calls.md
func TestCallLogsBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	f, _, tid, _ := insightFixture(t)
	ctx := context.Background()
	other := anotherAccount(t, f, "calls_viewer")
	f.a.Config.WebDir = "../../web/dist"
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"usage": map[string]any{"prompt_tokens": 25, "completion_tokens": 7, "total_tokens": 32}, "choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": `{"summary":"会议摘要","chapters":[{"segment_id":"s1","title":"开始"}]}`}}}})
	}))
	defer remote.Close()
	f.a.Config.LLMBaseURL = remote.URL
	seedFixtureSettings(t, f)
	f.json(t, "POST", "/api/v1/transcriptions/"+tid+"/insights", map[string]any{}, 202, uuid.NewString())
	work, err := f.a.claimInsight(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f.a.executeInsight(ctx, work)
	// More than one page, with a second owner's records, exercises the shared UI.
	for i := 0; i < 51; i++ {
		_, err = f.db.Exec(ctx, `INSERT INTO external_calls(id,owner_id,category,operation,provider,model,deadline_at,state,request_started,http_status,error_code,error_reason) VALUES($1,$2,'stt','upload','soniox','test-stt',clock_timestamp(),'failed',true,401,'auth','http_status')`, uuid.NewString(), userID(t, other))
		if err != nil {
			t.Fatal(err)
		}
	}
	cmdCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "vp", "exec", "e2e", "run", "tests/calls.e2e.ts")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_E2E_OUTPUT=.e2e/calls", "VOICES_TEST_URL="+f.server.URL)
	out, err := cmd.CombinedOutput()
	t.Log(string(out))
	if err != nil {
		t.Fatal(err)
	}
}
