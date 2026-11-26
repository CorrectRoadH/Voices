package app

import (
	"bytes"
	"context"
	"io"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"voices/internal/outbound"
	"voices/internal/providers"
)

type scribeProvider struct {
	submit func(context.Context, io.Reader, string, int64, providers.Options) (providers.Resource, error)
	fetch  func(context.Context, providers.Resource) (providers.Result, error)
	delete func(context.Context, providers.Resource) error
}

func (*scribeProvider) ID() string { return "elevenlabs" }
func (*scribeProvider) Models() []providers.Model {
	return providers.NewElevenLabs("").Models()
}
func (p *scribeProvider) SubmitFile(ctx context.Context, file io.Reader, name string, size int64, options providers.Options) (providers.Resource, error) {
	outbound.MarkStarted(ctx)
	return p.submit(ctx, file, name, size, options)
}
func (p *scribeProvider) FetchResult(ctx context.Context, resource providers.Resource) (providers.Result, error) {
	outbound.MarkStarted(ctx)
	return p.fetch(ctx, resource)
}
func (p *scribeProvider) DeleteResource(ctx context.Context, resource providers.Resource) error {
	outbound.MarkStarted(ctx)
	return p.delete(ctx, resource)
}

func scribeFixture(t *testing.T) (*fixture, *scribeProvider) {
	t.Helper()
	f := setup(t)
	p := &scribeProvider{
		submit: func(context.Context, io.Reader, string, int64, providers.Options) (providers.Resource, error) {
			t.Error("unexpected Scribe submission")
			return providers.Resource{}, &providers.Error{Code: "invalid", Definitive: true}
		},
		fetch: func(context.Context, providers.Resource) (providers.Result, error) {
			t.Error("unexpected Scribe result fetch")
			return providers.Result{}, &providers.Error{Code: "invalid"}
		},
		delete: func(context.Context, providers.Resource) error {
			t.Error("unexpected Scribe cleanup")
			return &providers.Error{Code: "invalid"}
		},
	}
	f.a.Providers[p.ID()] = p
	f.a.Config.ElevenLabsKey = "fixture-only"
	return f, p
}

func scribeOptions() providers.Options {
	return providers.Options{Provider: "elevenlabs", Model: "scribe_v2", LanguageMode: "single", Languages: []string{"en"}, Diarization: true}
}

func claimScribe(t *testing.T, a *App) job {
	t.Helper()
	j, err := a.claim(t.Context(), "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func checkScribeJob(t *testing.T, f *fixture, id, wantState, wantStage, wantCode string) {
	t.Helper()
	var state, stage, code string
	if err := f.db.QueryRow(t.Context(), "SELECT state,stage,COALESCE(error_code,'') FROM jobs WHERE id=$1", id).Scan(&state, &stage, &code); err != nil {
		t.Fatal(err)
	}
	if state != wantState || stage != wantStage || code != wantCode {
		t.Fatalf("job = %s/%s/%s, want %s/%s/%s", state, stage, code, wantState, wantStage, wantCode)
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestScribeSubmissionPersistsBeforeDispatchAndReusesKnownID(t *testing.T) {
	f, p := scribeFixture(t)
	ctx := t.Context()
	data := wav(1)
	out := f.upload(t, data, map[string]bool{"auto_transcribe": false}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", scribeOptions(), 202, uuid.NewString())
	j := claimScribe(t, f.a)
	checkScribeJob(t, f, j.ID, "running", "submitting", "")
	resource := providers.Resource{ID: "scribe-receipt", Kind: "transcription"}
	submits, fetches, deletes := 0, 0, 0
	p.submit = func(ctx context.Context, original io.Reader, name string, size int64, opts providers.Options) (providers.Resource, error) {
		submits++
		actual, err := io.ReadAll(original)
		if err != nil || !bytes.Equal(actual, data) || name != "meeting.wav" || size != int64(len(data)) {
			t.Fatalf("original=%s size=%d bytes=%d err=%v", name, size, len(actual), err)
		}
		if opts.Model != "scribe_v2" || opts.LanguageMode != "single" || !slices.Equal(opts.Languages, []string{"en"}) || !opts.Diarization {
			t.Fatalf("submit options: %+v", opts)
		}
		deadline, hasDeadline := ctx.Deadline()
		if !hasDeadline || time.Until(deadline) < 29*time.Minute || time.Until(deadline) > 30*time.Minute {
			t.Fatalf("submit deadline: %v", deadline)
		}
		var logged bool
		if err := f.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM provider_operations o JOIN external_calls c ON c.operation_id=o.id
		 WHERE o.job_id=$1 AND o.kind='submit' AND o.state='sent' AND c.provider='elevenlabs' AND c.operation='submit'
		 AND c.state='running' AND c.deadline_at-c.started_at BETWEEN interval '30 minutes' AND interval '31 minutes')`, j.ID).Scan(&logged); err != nil || !logged {
			t.Fatalf("durable submit and call log before dispatch: %v, %v", logged, err)
		}
		outbound.MarkStatus(ctx, 200)
		return resource, nil
	}
	p.fetch = func(ctx context.Context, got providers.Resource) (providers.Result, error) {
		fetches++
		if got != resource {
			t.Fatalf("fetch resource: %+v", got)
		}
		if fetches == 1 {
			outbound.MarkStatus(ctx, 503)
			return providers.Result{}, &providers.Error{Code: "transient"}
		}
		outbound.MarkStatus(ctx, 200)
		return providers.Result{Segments: []providers.Segment{{Text: "Readable transcript."}}}, nil
	}
	f.a.execute(ctx, j)
	checkScribeJob(t, f, j.ID, "retry_wait", "normalizing", "transient")
	if _, err := f.db.Exec(ctx, "UPDATE jobs SET next_run_at=clock_timestamp() WHERE id=$1", j.ID); err != nil {
		t.Fatal(err)
	}
	replacement := New(f.a.Config, f.db, p)
	replacement.execute(ctx, claimScribe(t, replacement))
	checkScribeJob(t, f, j.ID, "succeeded", "succeeded", "")
	_, recording := f.json(t, "GET", "/api/v1/recordings/"+rid, nil, 200, "")
	if recording["active_transcription_id"] != *j.TranscriptionID {
		t.Fatalf("published recording: %+v", recording)
	}
	_, segments := f.json(t, "GET", "/api/v1/transcriptions/"+*j.TranscriptionID+"/segments", nil, 200, "")
	items := segments["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["source_text"] != "Readable transcript." {
		t.Fatalf("published segments: %+v", items)
	}
	p.delete = func(ctx context.Context, got providers.Resource) error {
		deletes++
		if got != resource {
			t.Fatalf("delete resource: %+v", got)
		}
		if deletes == 1 {
			outbound.MarkStatus(ctx, 503)
			return &providers.Error{Code: "transient"}
		}
		outbound.MarkStatus(ctx, 404)
		return nil
	}
	if err := replacement.maintenance(ctx); err != nil {
		t.Fatal(err)
	}
	checkScribeJob(t, f, j.ID, "succeeded", "succeeded", "cleanup_transient")
	if _, err := f.db.Exec(ctx, "UPDATE provider_resources SET next_cleanup_at=clock_timestamp() WHERE transcription_id=$1 AND cleanup_state='failed'", *j.TranscriptionID); err != nil {
		t.Fatal(err)
	}
	if err := replacement.maintenance(ctx); err != nil {
		t.Fatal(err)
	}
	checkScribeJob(t, f, j.ID, "succeeded", "succeeded", "")
	var operations, resources, calls []string
	if err := f.db.QueryRow(ctx, `SELECT
	 (SELECT array_agg(kind||':'||state) FROM provider_operations WHERE job_id=$1),
	 (SELECT array_agg(kind||':'||cleanup_state) FROM provider_resources WHERE transcription_id=$2),
	 (SELECT array_agg(operation||':'||state||':'||COALESCE(http_status::text,'missing') ORDER BY operation,state) FROM external_calls WHERE job_id=$1 AND request_started)`, j.ID, *j.TranscriptionID).Scan(&operations, &resources, &calls); err != nil {
		t.Fatal(err)
	}
	wantCalls := []string{"delete_transcription:failed:503", "delete_transcription:succeeded:404", "fetch_result:failed:503", "fetch_result:succeeded:200", "submit:succeeded:200"}
	if submits != 1 || fetches != 2 || deletes != 2 || !slices.Equal(operations, []string{"submit:known"}) || !slices.Equal(resources, []string{"transcription:deleted"}) || !slices.Equal(calls, wantCalls) {
		t.Fatalf("submit=%d fetch=%d delete=%d operations=%v resources=%v call logs=%v", submits, fetches, deletes, operations, resources, calls)
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestScribeRestoreQuarantinesAutoImportBeforePrepare(t *testing.T) {
	f, p := scribeFixture(t)
	ctx := t.Context()
	f.upload(t, wav(1), map[string]any{"auto_transcribe": true, "transcription_options": scribeOptions()}, uuid.NewString(), 201)
	f.a.Config.RestoreMode = true
	if err := f.a.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	f.a.Config.RestoreMode = false
	f.run(t, "prepare")
	if _, err := f.a.claim(ctx, "transcribe"); err != pgx.ErrNoRows {
		t.Fatalf("restored intent was claimable: %v", err)
	}
	var jid, op string
	var operations []string
	if err := f.db.QueryRow(ctx, `SELECT j.id, o.id, ARRAY(SELECT kind||':'||state FROM provider_operations WHERE job_id=j.id)
	 FROM jobs j JOIN provider_operations o ON o.job_id=j.id AND o.kind='submit' WHERE j.kind='transcribe'`).Scan(&jid, &op, &operations); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(operations, []string{"submit:uncertain"}) {
		t.Fatalf("restored operations: %v", operations)
	}
	checkScribeJob(t, f, jid, "restore_hold", "submitting", "restore_hold")
	f.json(t, "POST", "/api/v1/jobs/"+jid+"/resolve", map[string]any{"note": "暂未查到"}, 200, "")
	f.json(t, "POST", "/api/v1/jobs/"+jid+"/retry", map[string]any{}, 409, "")
	checkScribeJob(t, f, jid, "restore_hold", "submitting", "restore_hold")
	resource := providers.Resource{ID: "scribe-restored", Kind: "transcription"}
	if err := f.a.ReconcileJob(ctx, jid, op, resource.ID, "已核对远端转写的归属"); err != nil {
		t.Fatal(err)
	}
	checkScribeJob(t, f, jid, "queued", "normalizing", "")
	p.fetch = func(_ context.Context, got providers.Resource) (providers.Result, error) {
		if got != resource {
			t.Fatalf("fetch resource: %+v", got)
		}
		return providers.Result{Segments: []providers.Segment{{Text: "Recovered result."}}}, nil
	}
	if j := f.run(t, "transcribe"); j.ID != jid {
		t.Fatalf("published job %s, want %s", j.ID, jid)
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestScribeLeaseTakeoverRetainsUncertainSubmissionUntilLateReceipt(t *testing.T) {
	f, p := scribeFixture(t)
	ctx := t.Context()
	out := f.upload(t, wav(1), map[string]any{"auto_transcribe": true, "transcription_options": scribeOptions()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	j := claimScribe(t, f.a)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	resource := providers.Resource{ID: "scribe-late", Kind: "transcription"}
	var released sync.Once
	finishSubmit := func() { released.Do(func() { close(release) }) }
	p.submit = func(ctx context.Context, original io.Reader, _ string, _ int64, _ providers.Options) (providers.Resource, error) {
		if _, err := io.Copy(io.Discard, original); err != nil {
			return providers.Resource{}, err
		}
		select {
		case <-entered:
			t.Error("lease takeover dispatched another submit")
			return providers.Resource{}, &providers.Error{Code: "uncertain"}
		default:
			close(entered)
		}
		<-release
		outbound.MarkStatus(ctx, 200)
		return resource, nil
	}
	go func() {
		defer close(done)
		f.a.execute(ctx, j)
	}()
	t.Cleanup(func() { finishSubmit(); <-done })
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("submit failed to start")
	}
	if _, err := f.db.Exec(ctx, "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", j.ID); err != nil {
		t.Fatal(err)
	}
	replacement := New(f.a.Config, f.db, p)
	replacement.execute(ctx, claimScribe(t, replacement))
	checkScribeJob(t, f, j.ID, "uncertain", "submitting", "uncertain")
	f.json(t, "POST", "/api/v1/jobs/"+j.ID+"/retry", map[string]any{}, 409, "")
	f.json(t, "POST", "/api/v1/jobs/"+j.ID+"/resolve", map[string]any{"note": "暂未查到"}, 200, "")
	f.json(t, "POST", "/api/v1/transcriptions/"+*j.TranscriptionID+"/cancel", nil, 202, "")
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	if err := replacement.maintenance(ctx); err != nil {
		t.Fatal(err)
	}
	var recordingState string
	if err := f.db.QueryRow(ctx, "SELECT state FROM recordings WHERE id=$1", rid).Scan(&recordingState); err != nil || recordingState != "deleting" {
		t.Fatalf("recording tombstone before receipt: %q, %v", recordingState, err)
	}
	finishSubmit()
	<-done
	var operations []string
	if err := f.db.QueryRow(ctx, "SELECT array_agg(kind||':'||state||':'||COALESCE(remote_id,'')) FROM provider_operations WHERE job_id=$1", j.ID).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(operations, []string{"submit:known:scribe-late"}) {
		t.Fatalf("late submit receipts: %v", operations)
	}
	deletes := 0
	p.delete = func(_ context.Context, got providers.Resource) error {
		deletes++
		if got != resource {
			t.Fatalf("delete resource: %+v", got)
		}
		return nil
	}
	if err := replacement.maintenance(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(ctx, "SELECT state FROM recordings WHERE id=$1", rid).Scan(&recordingState); err != pgx.ErrNoRows || deletes != 1 {
		t.Fatalf("recording after cleanup: %v, deletes=%d", err, deletes)
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestScribeCancelledUncertainJobCleansReconciledReceipt(t *testing.T) {
	f, p := scribeFixture(t)
	ctx := t.Context()
	f.upload(t, wav(1), map[string]any{"auto_transcribe": true, "transcription_options": scribeOptions()}, uuid.NewString(), 201)
	f.run(t, "prepare")
	j := claimScribe(t, f.a)
	p.submit = func(context.Context, io.Reader, string, int64, providers.Options) (providers.Resource, error) {
		return providers.Resource{}, &providers.Error{Code: "uncertain", Reason: "timeout"}
	}
	f.a.execute(ctx, j)
	checkScribeJob(t, f, j.ID, "uncertain", "submitting", "uncertain")
	f.json(t, "POST", "/api/v1/transcriptions/"+*j.TranscriptionID+"/cancel", nil, 202, "")
	var op string
	if err := f.db.QueryRow(ctx, "SELECT id FROM provider_operations WHERE job_id=$1 AND kind='submit' AND state='uncertain'", j.ID).Scan(&op); err != nil {
		t.Fatal(err)
	}
	resource := providers.Resource{ID: "scribe-cancelled", Kind: "transcription"}
	if err := f.a.ReconcileJob(ctx, j.ID, op, resource.ID, "已核对取消后返回的转写 ID"); err != nil {
		t.Fatal(err)
	}
	checkScribeJob(t, f, j.ID, "cancelled", "normalizing", "")
	deletes := 0
	p.delete = func(_ context.Context, got providers.Resource) error {
		if got != resource {
			t.Fatalf("delete resource: %+v", got)
		}
		deletes++
		if deletes == 1 {
			return &providers.Error{Code: "transient"}
		}
		return nil
	}
	if err := f.a.maintenance(ctx); err != nil {
		t.Fatal(err)
	}
	checkScribeJob(t, f, j.ID, "cancelled", "normalizing", "cleanup_transient")
	if _, err := f.db.Exec(ctx, "UPDATE provider_resources SET next_cleanup_at=clock_timestamp() WHERE transcription_id=$1 AND cleanup_state='failed'", *j.TranscriptionID); err != nil {
		t.Fatal(err)
	}
	if err := f.a.maintenance(ctx); err != nil {
		t.Fatal(err)
	}
	checkScribeJob(t, f, j.ID, "cancelled", "normalizing", "")
	var state string
	if err := f.db.QueryRow(ctx, "SELECT cleanup_state FROM provider_resources WHERE transcription_id=$1", *j.TranscriptionID).Scan(&state); err != nil || state != "deleted" {
		t.Fatalf("cancelled resource cleanup: %q, %v", state, err)
	}
}
