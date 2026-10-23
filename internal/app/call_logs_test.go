package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"voices/internal/outbound"
	"voices/internal/providers"
)

// @use-case docs/feature/call-logs/use-case/inspect-calls.md
func TestCallLogsIsolationPaginationAndLifecycle(t *testing.T) {
	f, rid, tid, _ := insightFixture(t)
	ctx := context.Background()
	other := anotherAccount(t, f, "calls_other")
	owner := userID(t, f)
	c, err := f.a.transcriptionCall(ctx, f.db, tid, "poll")
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for i := 0; i < 3; i++ {
		id, e := startCall(ctx, f.db, c, time.Second)
		if e != nil {
			t.Fatal(e)
		}
		ids = append(ids, id)
	}
	_, err = f.db.Exec(ctx, `UPDATE external_calls SET started_at=date_trunc('second',clock_timestamp()),deadline_at=clock_timestamp()-interval '1 second'`)
	if err != nil {
		t.Fatal(err)
	}
	other.json(t, "GET", "/api/v1/admin/calls", nil, 403, "")
	_, page := other.json(t, "GET", "/api/v1/calls?transcription_id="+tid, nil, 200, "")
	if len(page["items"].([]any)) != 0 {
		t.Fatal("cross-owner read")
	}
	for _, q := range []string{"owner_id=" + owner, "account=other", "state=bad", "category=oops", "limit=101", "cursor=abc", "job_id=bad", "from=bad", "model=x&model=y", "what=ever"} {
		f.json(t, "GET", "/api/v1/calls?"+q, nil, 400, "")
	}
	seen := map[string]bool{}
	path := "/api/v1/calls?state=interrupted&limit=1"
	for {
		_, page = f.json(t, "GET", path, nil, 200, "")
		for _, item := range page["items"].([]any) {
			v := item.(map[string]any)
			id := v["id"].(string)
			if seen[id] || v["state"] != "interrupted" || v["actor"] != nil || v["finished_at"] != nil {
				t.Fatal(v)
			}
			seen[id] = true
		}
		if page["next_cursor"] == nil {
			break
		}
		cursor := page["next_cursor"].(string)
		other.json(t, "GET", "/api/v1/calls?cursor="+cursor, nil, 200, "")
		path = "/api/v1/calls?state=interrupted&limit=1&cursor=" + cursor
	}
	if len(seen) != 3 {
		t.Fatal(seen)
	}
	// Restore and deletion never prevent a late completion, nor restore business data.
	f.a.Config.RestoreMode = true
	if err = f.a.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	f.a.Config.RestoreMode = false
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	if err = f.a.deleteOneRecording(ctx); err != nil {
		t.Fatal(err)
	}
	observed, o := outbound.WithObservation(ctx)
	outbound.MarkStarted(observed)
	outbound.MarkStatus(observed, 200)
	f.a.finishCall(ctx, ids[0], time.Now(), o, nil)
	_, page = f.json(t, "GET", "/api/v1/calls?state=succeeded", nil, 200, "")
	v := page["items"].([]any)[0].(map[string]any)
	if v["can_open_recording"] != false || v["recording_available"] != false || v["request_started"] != true {
		t.Fatal(v)
	}
	f.a.finishCall(ctx, ids[0], time.Now(), o, errors.New("SECRET")) // first completion wins
	_, err = f.db.Exec(ctx, `UPDATE external_calls SET started_at=clock_timestamp()-interval '31 days' WHERE id=$1`, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if err = f.a.pruneCalls(ctx); err != nil {
		t.Fatal(err)
	}
	f.a.finishCall(ctx, ids[0], time.Now(), o, nil)
	var n int
	if err = f.db.QueryRow(ctx, `SELECT count(*) FROM external_calls WHERE id=$1`, ids[0]).Scan(&n); err != nil || n != 0 {
		t.Fatal("resurrected", err)
	}
	_, page = f.json(t, "GET", "/api/v1/admin/calls?account=tester", nil, 200, "")
	if len(page["items"].([]any)) != 2 {
		t.Fatal(page)
	}
	f.json(t, "GET", "/api/v1/admin/calls?account=%25", nil, 200, "")
	// Current role is checked again for the same authenticated session.
	_, err = f.db.Exec(ctx, `UPDATE users SET role='user' WHERE id=$1`, owner)
	if err != nil {
		t.Fatal(err)
	}
	f.json(t, "GET", "/api/v1/admin/calls", nil, 403, "")
}

// @use-case docs/feature/call-logs/use-case/inspect-calls.md
func TestCallLogsSTTEntryAndWriteFailure(t *testing.T) {
	remote := fakeRemote(t)
	f := setup(t)
	ctx := context.Background()
	f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	f.run(t, "prepare")
	j, err := f.a.claim(ctx, "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.Exec(ctx, `CREATE FUNCTION reject_call() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no log'; END $$; CREATE TRIGGER reject_call BEFORE INSERT ON external_calls FOR EACH ROW EXECUTE FUNCTION reject_call()`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.a.remoteCreate(ctx, j, "soniox", "upload", func(context.Context) (providers.Resource, error) {
		t.Fatal("sent without a log")
		return providers.Resource{}, nil
	})
	if err == nil {
		t.Fatal("expected insert error")
	}
	var sent int
	f.db.QueryRow(ctx, `SELECT count(*) FROM provider_operations WHERE state='sent'`).Scan(&sent)
	if sent != 0 {
		t.Fatal("sent survived rollback")
	}
	if _, err = f.db.Exec(ctx, `DROP TRIGGER reject_call ON external_calls`); err != nil {
		t.Fatal(err)
	}
	f.a.execute(ctx, j)
	for i := 0; i < 2; i++ {
		if err = f.a.cleanupRemote(ctx); err != nil {
			t.Fatal(err)
		}
	}
	_, page := f.json(t, "GET", "/api/v1/calls?job_id="+j.ID, nil, 200, "")
	counts := map[string]int{}
	for _, item := range page["items"].([]any) {
		v := item.(map[string]any)
		counts[v["operation"].(string)]++
		if v["state"] != "succeeded" || v["request_started"] != true || v["http_status"] == nil {
			t.Fatal(v)
		}
	}
	for _, op := range []string{"upload", "submit", "fetch_result", "delete_file", "delete_transcription"} {
		if counts[op] != 1 {
			t.Fatal(counts)
		}
	}
	if counts["poll"] != 2 || remote.uploads.Load() != 1 || remote.submits.Load() != 1 || remote.deletes.Load() != 2 {
		t.Fatal(counts)
	}
}

// @use-case docs/feature/call-logs/use-case/inspect-calls.md
func TestCallLogsAIUsageAndGeneration(t *testing.T) {
	f, _, tid, _ := insightFixture(t)
	ctx := context.Background()
	var calls atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeJSON(w, 200, map[string]any{"usage": map[string]any{"prompt_tokens": 0, "completion_tokens": 7}, "choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": `{"summary":"SECRET","chapters":[{"segment_id":"missing","title":"SECRET"}]}`}}}})
	}))
	defer remote.Close()
	f.a.Config.LLMBaseURL = remote.URL
	seedFixtureSettings(t, f)
	for i := 0; i < 2; i++ {
		f.json(t, "POST", "/api/v1/transcriptions/"+tid+"/insights", map[string]any{}, 202, uuid.NewString())
		work, err := f.a.claimInsight(ctx)
		if err != nil {
			t.Fatal(err)
		}
		f.a.executeInsight(ctx, work)
	}
	_, page := f.json(t, "GET", "/api/v1/calls?category=ai", nil, 200, "")
	if len(page["items"].([]any)) != 2 || calls.Load() != 2 {
		t.Fatal(page)
	}
	for _, item := range page["items"].([]any) {
		v := item.(map[string]any)
		if v["input_tokens"] != float64(0) || v["output_tokens"] != float64(7) || v["total_tokens"] != nil || v["state"] != "failed" || v["error_reason"] != "unknown_segment" {
			t.Fatal(v)
		}
	}
	if strings.Contains(string(jsonBytes(page)), "SECRET") || strings.Contains(string(jsonBytes(page)), remote.URL) {
		t.Fatal("content leak")
	}
	// Strict cursor JSON rejects undeclared properties, even when IDs are valid.
	cursor := base64.RawURLEncoding.EncodeToString(jsonBytes(map[string]any{"started_at": time.Now(), "id": uuid.NewString(), "owner_id": uuid.NewString()}))
	f.json(t, "GET", "/api/v1/calls?cursor="+cursor, nil, 400, "")
}

// dropCommitReply models a committed PostgreSQL transaction whose acknowledgement
// never reaches the client. Only the wire boundary is faked, not app transactions.
type dropCommitReply struct {
	net.Conn
	remaining *atomic.Int32
	dropping  bool
	dropped   *atomic.Bool
}

func (c *dropCommitReply) Write(p []byte) (int, error) {
	if bytes.Contains(bytes.ToUpper(p), []byte("COMMIT\x00")) && c.remaining.Add(-1) == 0 {
		c.dropping = true
	}
	return c.Conn.Write(p)
}
func (c *dropCommitReply) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if c.dropping && n > 0 {
		c.dropped.Store(true)
		c.Conn.Close()
		return 0, io.ErrUnexpectedEOF
	}
	return n, err
}
func loseCommitReply(t *testing.T, f *fixture, number int32) *atomic.Bool {
	t.Helper()
	cfg := f.db.Config()
	counter := &atomic.Int32{}
	counter.Store(number)
	dropped := &atomic.Bool{}
	cfg.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &dropCommitReply{Conn: conn, remaining: counter, dropped: dropped}, nil
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	original := f.a.DB
	f.a.DB = pool
	t.Cleanup(func() { f.a.DB = original; pool.Close() })
	return dropped
}

// @use-case docs/feature/call-logs/use-case/inspect-calls.md
func TestCallLogsUnknownCommitDoesNotSend(t *testing.T) {
	t.Run("stt", func(t *testing.T) {
		remote := fakeRemote(t)
		f := setup(t)
		ctx := context.Background()
		f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
		f.run(t, "prepare")
		j, err := f.a.claim(ctx, "transcribe")
		if err != nil {
			t.Fatal(err)
		}
		dropped := loseCommitReply(t, f, 2)
		_, err = f.a.remoteCreate(ctx, j, "soniox", "upload", func(context.Context) (providers.Resource, error) {
			t.Fatal("send after unknown commit")
			return providers.Resource{}, nil
		})
		if err == nil || !dropped.Load() {
			t.Fatal("no lost commit reply", err)
		}
		var n int
		if err = f.db.QueryRow(ctx, `SELECT count(*) FROM external_calls c JOIN provider_operations o ON o.id=c.operation_id WHERE c.state='running' AND o.state='sent'`).Scan(&n); err != nil || n != 1 {
			t.Fatal("transaction was not committed", n, err)
		}
		f.a.execute(ctx, j)
		if remote.uploads.Load() != 0 || remote.submits.Load() != 0 {
			t.Fatal("replayed committed operation")
		}
	})
	t.Run("ai", func(t *testing.T) {
		f, _, tid, _ := insightFixture(t)
		ctx := context.Background()
		f.json(t, "POST", "/api/v1/transcriptions/"+tid+"/insights", map[string]any{}, 202, uuid.NewString())
		dropped := loseCommitReply(t, f, 1)
		_, err := f.a.claimInsight(ctx)
		if err == nil || !dropped.Load() {
			t.Fatal("no lost commit reply", err)
		}
		var n int
		if err = f.db.QueryRow(ctx, `SELECT count(*) FROM external_calls c JOIN transcription_insights i ON i.generation=c.generation WHERE c.state='running' AND i.state='running'`).Scan(&n); err != nil || n != 1 {
			t.Fatal(n, err)
		}
		if _, err = f.a.claimInsight(ctx); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("claimed again", err)
		}
	})
}

// @use-case docs/feature/call-logs/use-case/inspect-calls.md
func TestCallLogsAdminOperationsAndFinishFailure(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	var remoteCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		remoteCalls.Add(1)
		if strings.HasSuffix(r.URL.Path, "/models") {
			writeJSON(w, 200, map[string]any{"data": []any{map[string]any{"id": "test-model"}}})
		} else {
			sampleLLM(w)
		}
	}))
	defer srv.Close()
	f.a.Config.LLMBaseURL = srv.URL
	f.a.Config.LLMModel = "test-model"
	seedFixtureSettings(t, f)
	var revision int64
	if err := f.db.QueryRow(ctx, `SELECT revision FROM server_settings WHERE id=1`).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	f.json(t, "POST", "/api/v1/admin/llm-models", map[string]any{"revision": revision, "base_url": srv.URL}, 200, "")
	// A result persistence error must not turn a successful external request into
	// a retry or a failed user operation. Only external_calls updates are rejected.
	_, err := f.db.Exec(ctx, `CREATE FUNCTION reject_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no finish'; END $$; CREATE TRIGGER reject_finish BEFORE UPDATE ON external_calls FOR EACH ROW EXECUTE FUNCTION reject_finish()`)
	if err != nil {
		t.Fatal(err)
	}
	f.json(t, "POST", "/api/v1/admin/llm-test", map[string]any{"revision": revision}, 200, "")
	if remoteCalls.Load() != 2 {
		t.Fatal("remote operation repeated")
	}
	if _, err = f.db.Exec(ctx, `DROP TRIGGER reject_finish ON external_calls; UPDATE external_calls SET deadline_at=clock_timestamp()-interval '1 second' WHERE state='running'`); err != nil {
		t.Fatal(err)
	}
	_, page := f.json(t, "GET", "/api/v1/calls?category=ai", nil, 200, "")
	for _, item := range page["items"].([]any) {
		v := item.(map[string]any)
		switch v["operation"] {
		case "list_models":
			if v["state"] != "succeeded" || v["request_started"] != true || v["http_status"] != float64(200) || v["input_tokens"] != nil {
				t.Fatal(v)
			}
		case "test_model":
			if v["state"] != "interrupted" || v["request_started"] != nil || v["finished_at"] != nil {
				t.Fatal(v)
			}
		default:
			t.Fatal(v)
		}
	}
	if len(page["items"].([]any)) != 2 {
		t.Fatal(page)
	}
}
