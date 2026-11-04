package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
	"voices/internal/providers"
	"voices/internal/voiceprints"
)

type voiceprintSTT struct{ providers.Adapter }

func (p voiceprintSTT) FetchResult(context.Context, providers.Resource) (providers.Result, error) {
	a, b, c := int64(0), int64(8000), int64(16000)
	speaker := "A"
	return providers.Result{Raw: []byte(`{}`), Segments: []providers.Segment{{Text: "第一段发言。", StartMS: &a, EndMS: &b, Speaker: &speaker}, {Text: "第二段发言。", StartMS: &b, EndMS: &c, Speaker: &speaker}}}, nil
}
func voiceprintRecording(t *testing.T, f *fixture, seconds int) (rid, tid, label string) {
	t.Helper()
	f.a.Providers["soniox"] = voiceprintSTT{f.a.Providers["soniox"]}
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
func serveVoiceprint(t *testing.T, f *fixture, fn func(http.ResponseWriter, *http.Request)) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(fn))
	t.Cleanup(srv.Close)
	f.a.Config.VoiceprintURL = srv.URL
}
func voiceprintResponse(w http.ResponseWriter, r *http.Request, index int) {
	raw, _ := io.ReadAll(r.Body)
	if len(raw) < 96000 || len(raw) > 320000 || r.URL.Path != "/embedding" || r.Header.Get("Content-Type") != "application/octet-stream" {
		w.WriteHeader(400)
		return
	}
	writeJSON(w, 200, map[string]any{"model": voiceprints.Model, "embedding": testVector(index)})
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
	serveVoiceprint(t, f, func(w http.ResponseWriter, r *http.Request) { voiceprintResponse(w, r, 0) })
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
	serveVoiceprint(t, f, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		voiceprintResponse(w, r, 0)
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
	serveVoiceprint(t, f, func(w http.ResponseWriter, r *http.Request) {
		switch mode.Load() {
		case 0:
			w.WriteHeader(503)
		case 1:
			voiceprintResponse(w, r, int(calls.Add(1)%2))
		default:
			voiceprintResponse(w, r, 0)
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
	serveVoiceprint(t, f, func(w http.ResponseWriter, r *http.Request) { voiceprintResponse(w, r, 0) })
	_, tid, label := voiceprintRecording(t, f, 20)
	_, person := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "升级前的人物"}, 201, uuid.NewString())
	// In this isolated schema, restore the pre-018 shape and perform the exact
	// old association/unlink writes. The old schema has no identity provenance.
	ctx := context.Background()
	for _, sql := range []string{"DROP TABLE speaker_voiceprints,voiceprint_tasks,voiceprint_execution", "ALTER TABLE speaker_labels DROP COLUMN identity_source CASCADE, DROP COLUMN match_score CASCADE", "DELETE FROM schema_migrations WHERE name='018_voiceprints.sql'"} {
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
