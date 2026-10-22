package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func insightFixture(t *testing.T) (*fixture, string, string, []string) {
	t.Helper()
	f := setup(t)
	ctx := context.Background()
	upload := f.upload(t, wav(80), map[string]any{}, uuid.NewString(), 201)
	rid := upload["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	tid := uuid.NewString()
	var err error
	_, err = f.db.Exec(ctx, `INSERT INTO transcriptions(id,recording_id,provider,model,options_json,capability_snapshot_json,state) VALUES($1,$2,'soniox','test','{}','{}','succeeded')`, tid, rid)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for i, id := range ids {
		_, err = f.db.Exec(ctx, `INSERT INTO segments(id,transcription_id,ordinal,start_ms,end_ms,source_text) VALUES($1,$2,$3,$4,$5,$6)`, id, tid, i, i*1000, (i+1)*1000, fmt.Sprintf("主题 %d", i))
		if err != nil {
			t.Fatal(err)
		}
	}
	f.a.Config.LLMBaseURL = "http://127.0.0.1:1/v1"
	seedFixtureSettings(t, f)
	f.a.Config.LLMModel = "test-model"
	seedFixtureSettings(t, f)
	return f, rid, tid, ids
}
func fakeInsightServer(t *testing.T, calls *atomic.Int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		content := string(jsonBytes(map[string]any{"summary": "会议摘要", "chapters": []any{map[string]any{"segment_id": "s1", "title": "开场"}, map[string]any{"segment_id": "s3", "title": "决定"}}}))
		writeJSON(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": content}}}})
	}))
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestInsightsOwnershipIdempotencyAndCleanup(t *testing.T) {
	f, rid, tid, _ := insightFixture(t)
	ctx := context.Background()
	var calls atomic.Int32
	remote := fakeInsightServer(t, &calls)
	defer remote.Close()
	f.a.Config.LLMBaseURL = remote.URL + "/v1"
	seedFixtureSettings(t, f)
	path := "/api/v1/transcriptions/" + tid + "/insights"
	other := anotherAccount(t, f, "insight_other")
	other.json(t, "GET", path, nil, 404, "")
	other.json(t, "POST", path, map[string]any{}, 404, uuid.NewString())
	key := uuid.NewString()
	_, queued := f.json(t, "POST", path, map[string]any{}, 202, key)
	_, same := f.json(t, "POST", path, map[string]any{}, 202, key)
	generation := queued["insight"].(map[string]any)["generation"]
	if same["insight"].(map[string]any)["generation"] != generation {
		t.Fatal("idempotency")
	}
	f.json(t, "POST", path, map[string]any{}, 409, uuid.NewString())
	second := New(f.a.Config, f.db)
	work, err := second.claimInsight(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.a.claimInsight(ctx); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("double claim", err)
	}
	second.executeInsight(ctx, work)
	_, result := f.json(t, "GET", path, nil, 200, "")
	v := result["insight"].(map[string]any)
	if v["state"] != "succeeded" || calls.Load() != 1 {
		t.Fatal(result, calls.Load())
	}
	var input []byte
	if err = f.db.QueryRow(ctx, `SELECT input_json FROM transcription_insights WHERE transcription_id=$1`, tid).Scan(&input); err != nil || input != nil {
		t.Fatal("snapshot retained", err)
	}
	f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
	f.json(t, "POST", path, map[string]any{}, 409, key)
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	f.json(t, "GET", path, nil, 404, "")
	if err = f.a.deleteOneRecording(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = f.db.QueryRow(ctx, "SELECT count(*) FROM transcription_insights").Scan(&n)
	if n != 0 {
		t.Fatal("result not removed")
	}
	_ = f.db.QueryRow(ctx, "SELECT count(*) FROM idempotency_keys WHERE scope=$1", "insights:"+tid).Scan(&n)
	if n != 0 {
		t.Fatal("keys retained")
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestInsightsRestoreExpiryAndLimits(t *testing.T) {
	f, _, tid, _ := insightFixture(t)
	ctx := context.Background()
	path := "/api/v1/transcriptions/" + tid + "/insights"
	f.a.Config.LLMModel = ""
	seedFixtureSettings(t, f)
	f.json(t, "POST", path, map[string]any{}, 409, uuid.NewString())
	f.a.Config.LLMModel = "test-model"
	seedFixtureSettings(t, f)
	f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
	f.a.Config.RestoreMode = true
	if err := f.a.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	f.json(t, "POST", path, map[string]any{}, 409, uuid.NewString())
	f.a.Config.RestoreMode = false
	if _, err := f.a.claimInsight(ctx); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("restore replay", err)
	}
	_, result := f.json(t, "GET", path, nil, 200, "")
	if result["insight"].(map[string]any)["error_code"] != "interrupted" {
		t.Fatal(result)
	}
	f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
	work, err := f.a.claimInsight(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.Exec(ctx, `UPDATE transcription_insights SET lease_until=clock_timestamp()-interval '1 second' WHERE transcription_id=$1`, tid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.a.claimInsight(ctx); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("expired work reclaimed", err)
	}
	_, result = f.json(t, "GET", path, nil, 200, "")
	if result["insight"].(map[string]any)["state"] != "failed" {
		t.Fatal("expiry rolled back")
	}
	// Old generation completion cannot overwrite an explicitly new request.
	f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
	f.a.Config.LLMModel = "different"
	seedFixtureSettings(t, f)
	f.a.executeInsight(ctx, work)
	_, result = f.json(t, "GET", path, nil, 200, "")
	if result["insight"].(map[string]any)["state"] != "queued" {
		t.Fatal("fence broken")
	}
	if err = f.a.Restore(ctx); err != nil {
		t.Fatal(err)
	} // restore false is a no-op
	_, err = f.db.Exec(ctx, `UPDATE transcription_insights SET state='failed'; UPDATE segments SET edited_text=''`)
	if err != nil {
		t.Fatal(err)
	}
	f.json(t, "POST", path, map[string]any{}, 422, uuid.NewString())
	_, err = f.db.Exec(ctx, `UPDATE segments SET edited_text=$1 WHERE ordinal=0`, strings.Repeat("x", 200001))
	if err != nil {
		t.Fatal(err)
	}
	f.json(t, "POST", path, map[string]any{}, 422, uuid.NewString())
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestInsightsRunCancellationAndConcurrency(t *testing.T) {
	f, _, tid, _ := insightFixture(t)
	ctx := context.Background()
	path := "/api/v1/transcriptions/" + tid + "/insights"
	started := make(chan struct{})
	var once sync.Once
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		once.Do(func() { close(started) })
		<-r.Context().Done()
	}))
	defer remote.Close()
	f.a.Config.LLMBaseURL = remote.URL
	seedFixtureSettings(t, f)
	f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { f.a.Run(runCtx); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("worker never ran")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown stuck")
	}
	_, result := f.json(t, "GET", path, nil, 200, "")
	if result["insight"].(map[string]any)["error_code"] != "interrupted" {
		t.Fatal(result)
	}
	var raw []byte
	if err := f.db.QueryRow(ctx, "SELECT input_json FROM transcription_insights WHERE transcription_id=$1", tid).Scan(&raw); err != nil || raw != nil {
		t.Fatal("input not cleared", err)
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestInsightsConcurrentRequestsAndClaim(t *testing.T) {
	f, _, tid, _ := insightFixture(t)
	ctx := context.Background()
	path := "/api/v1/transcriptions/" + tid + "/insights"
	f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
	second := New(f.a.Config, f.db)
	var wg sync.WaitGroup
	var claimed atomic.Int32
	for _, a := range []*App{f.a, second} {
		wg.Add(1)
		go func(a *App) {
			defer wg.Done()
			if _, err := a.claimInsight(ctx); err == nil {
				claimed.Add(1)
			} else if !errors.Is(err, pgx.ErrNoRows) {
				t.Error(err)
			}
		}(a)
	}
	wg.Wait()
	if claimed.Load() != 1 {
		t.Fatal("claims", claimed.Load())
	}
}
