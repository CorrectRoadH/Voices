package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"voices/internal/insights"
)

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestAdministrationInsightsBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	for _, scenario := range []struct {
		name, title string
		calls       int32
	}{
		{"insights", "目录内生成、失败重试、章节定位及手机深色操作", 4},
		{"administration", "管理概览、审计筛选与日志分页", 0},
		{"account-filters", "账号关键词、角色与状态筛选以及停用", 0},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f, rid, tid, ids := insightFixture(t)
			ctx := context.Background()
			anotherAccount(t, f, "viewer")
			f.a.Config.WebDir = "../../web/dist"
			for i := 3; i < 75; i++ {
				id := uuid.NewString()
				ids = append(ids, id)
				if _, err := f.db.Exec(ctx, `INSERT INTO segments(id,transcription_id,ordinal,start_ms,end_ms,source_text) VALUES($1,$2,$3,$4,$5,$6)`, id, tid, i, i*1000, (i+1)*1000, "后续讨论"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.db.Exec(ctx, `UPDATE segments SET start_ms=NULL,end_ms=NULL WHERE id=$1`, ids[0]); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 52; i++ {
				if _, err := f.db.Exec(ctx, `INSERT INTO admin_audit_events(id,action) VALUES($1,'password_reset')`, uuid.NewString()); err != nil {
					t.Fatal(err)
				}
			}
			var calls atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := calls.Add(1)
				var body struct {
					Messages []struct {
						Content string `json:"content"`
					} `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				var input []insights.Segment
				if err := json.Unmarshal([]byte(body.Messages[1].Content), &input); err != nil {
					t.Error(err)
					return
				}
				first, last := input[0].ID, input[len(input)-1].ID
				if n == 2 {
					last = uuid.NewString()
				}
				content := string(jsonBytes(map[string]any{"summary": "会议摘要", "chapters": []any{map[string]any{"segment_id": first, "title": "开场"}, map[string]any{"segment_id": last, "title": "决定"}}}))
				writeJSON(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": content}}}})
			}))
			defer remote.Close()
			f.a.Config.LLMBaseURL = remote.URL
			seedFixtureSettings(t, f)
			runCtx, cancel := context.WithCancel(ctx)
			done := make(chan struct{})
			go func() { defer close(done); f.a.Run(runCtx) }()
			defer func() { cancel(); <-done }()
			deadline := 8 * time.Minute
			if scenario.name == "insights" {
				deadline = 14 * time.Minute
			}
			cmdCtx, stop := context.WithTimeout(ctx, deadline)
			defer stop()
			cmd := exec.CommandContext(cmdCtx, "vp", "exec", "e2e", "run", "tests/insights.e2e.ts", "--grep", scenario.title)
			cmd.Dir = "../../web"
			cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_E2E_OUTPUT=.e2e/"+scenario.name, "VOICES_TEST_URL="+f.server.URL, "VOICES_TEST_RECORDING="+rid, "VOICES_TEST_TRANSCRIPTION="+tid, "VOICES_TEST_LAST_SEGMENT="+ids[len(ids)-1])
			out, err := cmd.CombinedOutput()
			t.Log(string(out))
			if err != nil {
				t.Fatal(err)
			}
			if calls.Load() != scenario.calls {
				t.Fatal("unexpected model calls", calls.Load())
			}

		})
	}
}
