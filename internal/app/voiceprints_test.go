package app

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
	"voices/internal/providers"
	"voices/internal/voiceprints"
)

type voiceprintSTT struct{ providers.AsyncAdapter }

func (p voiceprintSTT) FetchResult(context.Context, providers.Resource) (providers.Result, error) {
	a, b, c := int64(0), int64(8000), int64(16000)
	speaker := "A"
	return providers.Result{Raw: []byte(`{}`), Segments: []providers.Segment{{Text: "第一段发言。", StartMS: &a, EndMS: &b, Speaker: &speaker}, {Text: "第二段发言。", StartMS: &b, EndMS: &c, Speaker: &speaker}}}, nil
}
func voiceprintRecording(t *testing.T, f *fixture, seconds int) (rid, tid, label string) {
	t.Helper()
	f.a.Providers["soniox"] = voiceprintSTT{f.a.Providers["soniox"].(providers.AsyncAdapter)}
	out := f.upload(t, wav(seconds), map[string]any{"title": "声纹验收", "auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid = out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	j := f.run(t, "transcribe")
	tid = *j.TranscriptionID
	if err := f.db.QueryRow(context.Background(), "SELECT id FROM speaker_labels WHERE transcription_id=$1", tid).Scan(&label); err != nil {
		t.Fatal(err)
	}
	return
}
func testVector(index int) []float64 { v := make([]float64, 192); v[index] = 1; return v }

type extractVoiceprintFunc func(context.Context, []byte) ([]float64, error)

func (f extractVoiceprintFunc) Extract(ctx context.Context, pcm []byte) ([]float64, error) {
	return f(ctx, pcm)
}
func (f extractVoiceprintFunc) Close() {}
func serveVoiceprint(t *testing.T, f *fixture, fn extractVoiceprintFunc) {
	t.Helper()
	f.a.voiceprintEngine = fn
}
func voiceprintResponse(pcm []byte, index int) ([]float64, error) {
	if len(pcm) < 96000 || len(pcm) > 320000 || len(pcm)%2 != 0 {
		return nil, errors.New("invalid PCM")
	}
	return testVector(index), nil
}
func runVoiceprint(t *testing.T, f *fixture) {
	t.Helper()
	w, err := f.a.claimVoiceprints(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	f.a.executeVoiceprints(context.Background(), w)
	var state, code string
	if err = f.db.QueryRow(context.Background(), "SELECT state,COALESCE(error_code,'') FROM voiceprint_tasks WHERE transcription_id=$1", w.TID).Scan(&state, &code); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" {
		t.Fatalf("voiceprint %s: %s", state, code)
	}
}
func assignVoiceprint(t *testing.T, f *fixture, label string, person any) {
	t.Helper()
	var revision int64
	if err := f.db.QueryRow(context.Background(), "SELECT revision FROM speaker_labels WHERE id=$1", label).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	f.json(t, "PATCH", "/api/v1/speaker-labels/"+label, map[string]any{"revision": revision, "person_id": person}, 200, "")
}
func assertIdentity(t *testing.T, f *fixture, label, source string, person any) {
	t.Helper()
	var gotSource string
	var gotPerson *string
	if err := f.db.QueryRow(context.Background(), "SELECT identity_source,person_id FROM speaker_labels WHERE id=$1", label).Scan(&gotSource, &gotPerson); err != nil {
		t.Fatal(err)
	}
	if gotSource != source || (person == nil && gotPerson != nil) || (person != nil && (gotPerson == nil || *gotPerson != person.(string))) {
		t.Fatalf("identity source=%s person=%v; want %s %v", gotSource, gotPerson, source, person)
	}
}

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintsEnrollRecognizeCorrectAndIsolate(t *testing.T) {
	remote := fakeRemote(t)
	f := setup(t)
	serveVoiceprint(t, f, func(ctx context.Context, pcm []byte) ([]float64, error) { return voiceprintResponse(pcm, 0) })
	rid, _, label := voiceprintRecording(t, f, 20)
	_, person := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "小王"}, 201, uuid.NewString())
	pid := person["id"].(string)
	assignVoiceprint(t, f, label, pid)
	runVoiceprint(t, f)
	_, profile := f.json(t, "GET", "/api/v1/people/"+pid+"/voiceprints", nil, 200, "")
	if profile["samples"] != float64(1) || profile["sample_ms"] != float64(16000) {
		t.Fatal(profile)
	}
	_, tid2, label2 := voiceprintRecording(t, f, 21)
	runVoiceprint(t, f)
	assertIdentity(t, f, label2, "automatic", pid)
	// Removing the sole manually confirmed recording must leave no reference,
	// despite a perfectly matching automatic label in the second recording.
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	_, _, label3 := voiceprintRecording(t, f, 22)
	runVoiceprint(t, f)
	assertIdentity(t, f, label3, "unassigned", nil)
	assignVoiceprint(t, f, label2, pid)
	runVoiceprint(t, f)
	_, _, label4 := voiceprintRecording(t, f, 23)
	runVoiceprint(t, f)
	assertIdentity(t, f, label4, "automatic", pid)
	assignVoiceprint(t, f, label4, nil)
	runVoiceprint(t, f)
	assertIdentity(t, f, label4, "manual", nil)
	f.json(t, "POST", "/api/v1/transcriptions/"+tid2+"/voiceprints", nil, 200, "")
	runVoiceprint(t, f)
	if remote.submits.Load() != 4 {
		t.Fatal("voiceprint retry resubmitted STT")
	}
	other := anotherAccount(t, f, "voiceprint-other")
	other.a = f.a
	other.json(t, "GET", "/api/v1/people/"+pid+"/voiceprints", nil, 404, "")
	other.json(t, "POST", "/api/v1/transcriptions/"+tid2+"/voiceprints", nil, 404, "")
	_, _, otherLabel := voiceprintRecording(t, other, 24)
	runVoiceprint(t, f)
	assertIdentity(t, f, otherLabel, "unassigned", nil)
	// Archiving removes the last manual reference immediately.
	_, p := f.json(t, "GET", "/api/v1/people/"+pid, nil, 200, "")
	f.json(t, "PATCH", "/api/v1/people/"+pid, map[string]any{"revision": p["revision"], "archived": true}, 200, "")
	_, _, label5 := voiceprintRecording(t, f, 25)
	runVoiceprint(t, f)
	assertIdentity(t, f, label5, "unassigned", nil)
}

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintExecutionSurvivesInvalidationAndDeletion(t *testing.T) {
	fakeRemote(t)
	f := setup(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	serveVoiceprint(t, f, func(ctx context.Context, pcm []byte) ([]float64, error) {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		return voiceprintResponse(pcm, 0)
	})
	rid, tid, label := voiceprintRecording(t, f, 20)
	work, err := f.a.claimVoiceprints(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { defer close(done); f.a.executeVoiceprints(context.Background(), work) }()
	released := false
	defer func() {
		if !released {
			close(release)
		}
		<-done
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("inference did not start")
	}
	for range 3 {
		assignVoiceprint(t, f, label, nil)
	}
	otherApp := New(f.a.Config, f.db)
	if _, err := otherApp.claimVoiceprints(context.Background()); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("slot released during invalidation: %v", err)
	}
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	if err := f.a.maintenance(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := otherApp.claimVoiceprints(context.Background()); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("slot released during delete: %v", err)
	}
	_, _, nextLabel := voiceprintRecording(t, f, 21)
	if _, err := otherApp.claimVoiceprints(context.Background()); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("parallel inference allowed", err)
	}
	close(release)
	released = true
	<-done
	var n int
	f.db.QueryRow(context.Background(), "SELECT count(*) FROM speaker_voiceprints v JOIN speaker_labels l ON l.id=v.label_id WHERE l.transcription_id=$1", tid).Scan(&n)
	if n != 0 {
		t.Fatal("stale sample published")
	}
	runVoiceprint(t, f)
	assertIdentity(t, f, nextLabel, "unassigned", nil)
}

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintFailureRetryPurityAndExpiredFence(t *testing.T) {
	fakeRemote(t)
	f := setup(t)
	var mode atomic.Int32
	var calls atomic.Int32
	serveVoiceprint(t, f, func(ctx context.Context, pcm []byte) ([]float64, error) {
		switch mode.Load() {
		case 0:
			return nil, errors.New("inference_unavailable")
		case 1:
			return voiceprintResponse(pcm, int(calls.Add(1)%2))
		default:
			return voiceprintResponse(pcm, 0)
		}
	})
	_, tid, label := voiceprintRecording(t, f, 20)
	work, err := f.a.claimVoiceprints(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	f.a.executeVoiceprints(context.Background(), work)
	_, status := f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/voiceprints", nil, 200, "")
	if status["task"].(map[string]any)["state"] != "failed" {
		t.Fatal(status)
	}
	mode.Store(1)
	f.json(t, "POST", "/api/v1/transcriptions/"+tid+"/voiceprints", nil, 200, "")
	runVoiceprint(t, f)
	_, status = f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/voiceprints", nil, 200, "")
	if status["samples"] != float64(0) {
		t.Fatal("mixed speakers accepted", status)
	}
	mode.Store(2)
	f.json(t, "POST", "/api/v1/transcriptions/"+tid+"/voiceprints", nil, 200, "")
	work, err = f.a.claimVoiceprints(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Exec(context.Background(), "UPDATE voiceprint_execution SET lease_until=clock_timestamp()-interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	if err = f.a.publishVoiceprints(context.Background(), work, []extractedVoiceprint{{label, testVector(0), 6000, 2}}); err == nil {
		t.Fatal("expired executor published")
	}
	if _, err = f.db.Exec(context.Background(), "UPDATE voiceprint_tasks SET lease_until=clock_timestamp()-interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	runVoiceprint(t, f)
	// Only a time/identity edit invalidates samples; text editing leaves them intact.
	_, segments := f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/segments", nil, 200, "")
	s := segments["items"].([]any)[0].(map[string]any)
	_, s = f.json(t, "PATCH", "/api/v1/segments/"+s["id"].(string), map[string]any{"revision": s["revision"], "edited_text": "改字"}, 200, "")
	_, status = f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/voiceprints", nil, 200, "")
	if status["samples"] != float64(1) {
		t.Fatal(status)
	}
	f.json(t, "PATCH", "/api/v1/segments/"+s["id"].(string), map[string]any{"revision": s["revision"], "assignment_mode": "unknown"}, 200, "")
	_, status = f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/voiceprints", nil, 200, "")
	if status["samples"] != float64(0) {
		t.Fatal("edited sample retained")
	}
}

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintLegacyUnlinkMigrationAndRestore(t *testing.T) {
	fakeRemote(t)
	f := setup(t)
	serveVoiceprint(t, f, func(ctx context.Context, pcm []byte) ([]float64, error) { return voiceprintResponse(pcm, 0) })
	_, tid, label := voiceprintRecording(t, f, 20)
	_, person := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "升级前的人物"}, 201, uuid.NewString())
	// In this isolated schema, restore the pre-018 shape and perform the exact
	// old association/unlink writes. The old schema has no identity provenance.
	ctx := context.Background()
	for _, sql := range []string{"DROP TABLE speaker_voiceprints,voiceprint_tasks,voiceprint_execution", "ALTER TABLE speaker_labels DROP COLUMN identity_source CASCADE, DROP COLUMN match_score CASCADE", "DELETE FROM schema_migrations WHERE name IN ('018_voiceprints.sql','019_embedded_voiceprints.sql')"} {
		if _, err := f.db.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.db.Exec(ctx, "UPDATE speaker_labels SET person_id=$2 WHERE id=$1", label, person["id"]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(ctx, "UPDATE speaker_labels SET person_id=NULL WHERE id=$1", label); err != nil {
		t.Fatal(err)
	}
	if err := persistence.Migrate(ctx, f.db); err != nil {
		t.Fatal(err)
	}
	assertIdentity(t, f, label, "manual", nil)
	f.json(t, "POST", "/api/v1/transcriptions/"+tid+"/voiceprints", nil, 200, "")
	runVoiceprint(t, f)
	assertIdentity(t, f, label, "manual", nil)
	_, _, newLabel := voiceprintRecording(t, f, 21)
	assertIdentity(t, f, newLabel, "unassigned", nil)
	old, err := f.a.claimVoiceprints(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f.a.Config.RestoreMode = true
	if err = f.a.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = f.a.claimVoiceprints(ctx); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("restore mode claimed work")
	}
	if err = f.a.publishVoiceprints(ctx, old, nil); err == nil {
		t.Fatal("pre-restore executor published")
	}
	f.a.Config.RestoreMode = false
	runVoiceprint(t, f)
}

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintEmbeddedMigrationPrioritizesReferences(t *testing.T) {
	for _, migration := range []string{"019_embedded_voiceprints.sql", "021_voiceprint_long_utterances.sql"} {
		t.Run(migration, func(t *testing.T) {

			fakeRemote(t)
			f := setup(t)
			serveVoiceprint(t, f, func(ctx context.Context, pcm []byte) ([]float64, error) { return voiceprintResponse(pcm, 0) })
			_, btid, b := voiceprintRecording(t, f, 20) // Anonymous recording sorts first.
			_, atid, a := voiceprintRecording(t, f, 21)
			_, person := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "历史人物"}, 201, uuid.NewString())
			pid := person["id"].(string)
			assignVoiceprint(t, f, a, pid)
			_, _, manualNull := voiceprintRecording(t, f, 22)
			assignVoiceprint(t, f, manualNull, nil)
			_, _, automatic := voiceprintRecording(t, f, 23)
			ctx := context.Background()
			if _, err := f.db.Exec(ctx, "UPDATE speaker_labels SET identity_source='automatic',person_id=$2,match_score=.95 WHERE id=$1", automatic, pid); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Exec(ctx, `INSERT INTO speaker_voiceprints(label_id,model,embedding,sample_ms,sample_count) SELECT id,'old-profile',$1,6000,2 FROM speaker_labels`, testVector(0)); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Exec(ctx, "UPDATE voiceprint_tasks SET state='succeeded'"); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Exec(ctx, "DELETE FROM schema_migrations WHERE name=$1", migration); err != nil {
				t.Fatal(err)
			}
			if err := persistence.Migrate(ctx, f.db); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Exec(ctx, "UPDATE voiceprint_tasks SET updated_at=clock_timestamp()-interval '1 day' WHERE transcription_id=$1", btid); err != nil {
				t.Fatal(err)
			}
			_, status := f.json(t, "GET", "/api/v1/people/"+pid+"/voiceprints", nil, 200, "")
			if status["configured"] != true || status["samples"] != float64(0) {
				t.Fatal("old profile counted", status)
			}
			work, err := f.a.claimVoiceprints(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if work.TID != atid {
				t.Fatal("anonymous task claimed before reference", work.TID)
			}
			f.a.executeVoiceprints(ctx, work)
			for range 3 {
				runVoiceprint(t, f)
			}
			assertIdentity(t, f, b, "automatic", pid)
			assertIdentity(t, f, a, "manual", pid)
			assertIdentity(t, f, manualNull, "manual", nil)
			assertIdentity(t, f, automatic, "automatic", pid)
			if _, err := f.a.claimVoiceprints(ctx); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatal(err)
			}

		})
	}
}

type lifecycleVoiceprintEngine struct {
	entered, release chan struct{}
	closed           atomic.Bool
	calls            atomic.Int32
}

func (e *lifecycleVoiceprintEngine) Extract(ctx context.Context, pcm []byte) ([]float64, error) {
	if e.calls.Add(1) == 1 {
		close(e.entered)
		<-e.release
	}
	if e.closed.Load() {
		return nil, errors.New("closed during native call")
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return voiceprintResponse(pcm, 0)
}
func (e *lifecycleVoiceprintEngine) Close() { e.closed.Store(true) }

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintRunOwnsNativeLifetime(t *testing.T) {
	fakeRemote(t)
	f := setup(t)
	_, tid, _ := voiceprintRecording(t, f, 20)
	engine := &lifecycleVoiceprintEngine{entered: make(chan struct{}), release: make(chan struct{})}
	f.a.voiceprintEngine = engine
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); f.a.Run(ctx) }()
	released := false
	defer func() {
		cancel()
		if !released {
			close(engine.release)
		}
		<-done
	}()
	select {
	case <-engine.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("worker did not enter inference")
	}
	var generation string
	if err := f.db.QueryRow(ctx, "SELECT generation FROM voiceprint_tasks WHERE transcription_id=$1", tid).Scan(&generation); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(ctx, "UPDATE voiceprint_tasks SET lease_until=clock_timestamp()-interval '1 second'; UPDATE voiceprint_execution SET lease_until=clock_timestamp()-interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	// Two worker ticks must not reclaim an expired task still executing locally.
	time.Sleep(2200 * time.Millisecond)
	var current string
	if err := f.db.QueryRow(ctx, "SELECT generation FROM voiceprint_tasks WHERE transcription_id=$1", tid).Scan(&current); err != nil {
		t.Fatal(err)
	}
	if current != generation || engine.calls.Load() != 1 {
		t.Fatal("in-flight native work was reclaimed")
	}
	cancel()
	select {
	case <-done:
		t.Fatal("shutdown abandoned native work")
	case <-time.After(50 * time.Millisecond):
	}
	if engine.closed.Load() {
		t.Fatal("native resource closed before worker returned")
	}
	close(engine.release)
	released = true
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("worker did not shut down")
	}
	if !engine.closed.Load() {
		t.Fatal("native resource leaked")
	}
	var free bool
	if err := f.db.QueryRow(context.Background(), "SELECT run_id IS NULL FROM voiceprint_execution").Scan(&free); err != nil || !free {
		t.Fatal("execution slot leaked", err)
	}
}

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintAutomaticMaintenance(t *testing.T) {
	fakeRemote(t)
	f := setup(t)
	_, tid, label := voiceprintRecording(t, f, 20)
	ctx := context.Background()
	if _, err := f.db.Exec(ctx, "DELETE FROM voiceprint_tasks WHERE transcription_id=$1", tid); err != nil {
		t.Fatal(err)
	}
	f.a.Config.RestoreMode = true
	if err := f.a.maintenance(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := f.db.QueryRow(ctx, "SELECT count(*) FROM voiceprint_tasks").Scan(&n); err != nil || n != 0 {
		t.Fatal("restore mode queued work", n, err)
	}
	f.a.Config.RestoreMode = false
	if err := f.a.maintenance(ctx); err != nil {
		t.Fatal(err)
	}
	var generation string
	if err := f.db.QueryRow(ctx, "SELECT generation FROM voiceprint_tasks WHERE transcription_id=$1", tid).Scan(&generation); err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"queued", "running", "succeeded"} {
		if _, err := f.db.Exec(ctx, "UPDATE voiceprint_tasks SET state=$2,updated_at=clock_timestamp()-interval '1 hour' WHERE transcription_id=$1", tid, state); err != nil {
			t.Fatal(err)
		}
		if err := f.a.maintainVoiceprints(ctx); err != nil {
			t.Fatal(err)
		}
		var got string
		if err := f.db.QueryRow(ctx, "SELECT generation FROM voiceprint_tasks WHERE transcription_id=$1", tid).Scan(&got); err != nil || got != generation {
			t.Fatal("active/finished task restarted", state, err)
		}
	}
	for _, code := range []string{"inference_unavailable", "interrupted", "processing_failed", "model_mismatch", "invalid_embedding", "too_many_segments"} {
		if _, err := f.db.Exec(ctx, "UPDATE voiceprint_tasks SET state='failed',error_code=$2,updated_at=clock_timestamp() WHERE transcription_id=$1", tid, code); err != nil {
			t.Fatal(err)
		}
		if err := f.a.maintainVoiceprints(ctx); err != nil {
			t.Fatal(err)
		}
		var state string
		if err := f.db.QueryRow(ctx, "SELECT state FROM voiceprint_tasks WHERE transcription_id=$1", tid).Scan(&state); err != nil || state != "failed" {
			t.Fatal("retry ignored cooldown", state, err)
		}
		if _, err := f.db.Exec(ctx, "UPDATE voiceprint_tasks SET updated_at=clock_timestamp()-interval '6 minutes' WHERE transcription_id=$1", tid); err != nil {
			t.Fatal(err)
		}
		if err := f.a.maintainVoiceprints(ctx); err != nil {
			t.Fatal(err)
		}
		if err := f.db.QueryRow(ctx, "SELECT state FROM voiceprint_tasks WHERE transcription_id=$1", tid).Scan(&state); err != nil {
			t.Fatal(err)
		}
		retry := code == "inference_unavailable" || code == "interrupted" || code == "processing_failed"
		if (state == "queued") != retry {
			t.Fatal(code, state)
		}
	}
	assertIdentity(t, f, label, "unassigned", nil)
}

// @use-case docs/feature/administration/use-case/inspect-instance.md
func TestVoiceprintRuntimeResults(t *testing.T) {
	fakeRemote(t)
	f := setup(t)
	var mode string
	serveVoiceprint(t, f, func(ctx context.Context, pcm []byte) ([]float64, error) {
		switch mode {
		case "unavailable":
			return nil, errors.New("inference_unavailable")
		case "silence":
			return nil, voiceprints.ErrAudio
		}
		return voiceprintResponse(pcm, 0)
	})
	_, tid, _ := voiceprintRecording(t, f, 20)
	runVoiceprint(t, f)
	check := func(kind, code string) {
		t.Helper()
		_, logs := f.json(t, "GET", "/api/v1/admin/runtime-events?kind="+kind, nil, 200, "")
		items := logs["items"].([]any)
		found := false
		for _, item := range items {
			if item.(map[string]any)["code"] == code {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing runtime event %s/%s: %v", kind, code, items)
		}
	}
	check("voiceprint_started", "processing")
	check("voiceprint_completed", "samples_ready")
	mode = "unavailable"
	f.json(t, "POST", "/api/v1/transcriptions/"+tid+"/voiceprints", nil, 200, "")
	work, err := f.a.claimVoiceprints(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	f.a.executeVoiceprints(context.Background(), work)
	check("voiceprint_failed", "inference_unavailable")
	mode = "silence"
	f.json(t, "POST", "/api/v1/transcriptions/"+tid+"/voiceprints", nil, 200, "")
	runVoiceprint(t, f)
	check("voiceprint_completed", "insufficient_audio")
	var before, after int
	if err := f.db.QueryRow(context.Background(), "SELECT count(*) FROM runtime_events WHERE kind='voiceprint_completed'").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := f.a.publishVoiceprints(context.Background(), work, nil); err == nil {
		t.Fatal("stale task published")
	}
	if err := f.db.QueryRow(context.Background(), "SELECT count(*) FROM runtime_events WHERE kind='voiceprint_completed'").Scan(&after); err != nil || before != after {
		t.Fatal("stale task logged completion", err)
	}
}

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintSamplingMigrationKeepsActiveWork(t *testing.T) {
	fakeRemote(t)
	f := setup(t)
	_, tid, _ := voiceprintRecording(t, f, 20)
	_, queued, _ := voiceprintRecording(t, f, 21)
	ctx := context.Background()
	work, err := f.a.claimVoiceprints(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if work.TID != tid {
		t.Fatal("unexpected task order")
	}
	var queuedGeneration string
	if err = f.db.QueryRow(ctx, "SELECT generation FROM voiceprint_tasks WHERE transcription_id=$1", queued).Scan(&queuedGeneration); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Exec(ctx, "DELETE FROM schema_migrations WHERE name='021_voiceprint_long_utterances.sql'"); err != nil {
		t.Fatal(err)
	}
	if err = persistence.Migrate(ctx, f.db); err != nil {
		t.Fatal(err)
	}
	if err = f.a.voiceprintCurrent(ctx, work); err != nil {
		t.Fatal("running work invalidated", err)
	}
	var generation, state string
	if err = f.db.QueryRow(ctx, "SELECT generation,state FROM voiceprint_tasks WHERE transcription_id=$1", queued).Scan(&generation, &state); err != nil || generation != queuedGeneration || state != "queued" {
		t.Fatal("queued work replaced", err)
	}
}
