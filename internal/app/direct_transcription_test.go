package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"voices/internal/providers"
)

func directFixture(t *testing.T, handler http.HandlerFunc) (*fixture, *atomic.Int32) {
	t.Helper()
	f := setup(t)
	calls := new(atomic.Int32)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); handler(w, r) }))
	t.Cleanup(upstream.Close)
	f.a.Config.OpenAISTTBaseURL = upstream.URL
	f.a.Config.OpenAISTTKey = "direct-test-secret"
	seedFixtureSettings(t, f)
	a, err := NewServer(context.Background(), f.a.Config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.a = a
	f.server.Config.Handler = a.Handler()
	return f, calls
}
func directOptions() providers.Options {
	return providers.Options{Provider: "openai", Model: "gpt-4o-transcribe-diarize", LanguageMode: "auto", Diarization: true}
}
func directRecording(t *testing.T, f *fixture, auto bool) string {
	t.Helper()
	meta := map[string]any{"auto_transcribe": auto}
	if auto {
		meta["transcription_options"] = directOptions()
	}
	out := f.upload(t, wav(1), meta, uuid.NewString(), 201)
	return out["recording"].(map[string]any)["id"].(string)
}
func createDirect(t *testing.T, f *fixture, rid string) job {
	t.Helper()
	_, created := f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", directOptions(), 202, uuid.NewString())
	if created["job"].(map[string]any)["duplicate_risk"] != false {
		t.Fatal("new queued direct job must have a boolean false risk")
	}
	j, err := f.a.claim(context.Background(), "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	return j
}
func assertDirectJob(t *testing.T, f *fixture, j job, state, code string) {
	t.Helper()
	var actual, actualCode string
	if err := f.db.QueryRow(context.Background(), "SELECT state,COALESCE(error_code,'') FROM jobs WHERE id=$1", j.ID).Scan(&actual, &actualCode); err != nil {
		t.Fatal(err)
	}
	if actual != state || actualCode != code {
		t.Fatalf("state=%s code=%s want %s/%s", actual, actualCode, state, code)
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestDirectTranscriptionSuccessAndConfiguration(t *testing.T) {
	f, calls := directFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/audio/transcriptions" || r.Header.Get("Authorization") != "Bearer direct-test-secret" {
			t.Error("wrong STT configuration")
		}
		io.Copy(io.Discard, r.Body)
		io.WriteString(w, `{"segments":[{"text":"Hello","speaker":"A","start":0,"end":0.5},{"text":"World","speaker":"B","start":0.5,"end":1}]}`)
	})
	rid := directRecording(t, f, false)
	f.run(t, "prepare")
	j := createDirect(t, f, rid)
	f.a.execute(context.Background(), j)
	assertDirectJob(t, f, j, "succeeded", "")
	var count, labels, resources, ops, logs int
	err := f.db.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM segments WHERE transcription_id=$1),(SELECT count(*) FROM speaker_labels WHERE transcription_id=$1),(SELECT count(*) FROM provider_resources WHERE transcription_id=$1),(SELECT count(*) FROM provider_operations WHERE job_id=$2),(SELECT count(*) FROM external_calls WHERE job_id=$2 AND operation='transcribe' AND provider='openai' AND state='succeeded')`, *j.TranscriptionID, j.ID).Scan(&count, &labels, &resources, &ops, &logs)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 || labels != 2 || resources != 0 || ops != 0 || logs != 1 || calls.Load() != 1 {
		t.Fatalf("segments=%d labels=%d resources=%d ops=%d logs=%d calls=%d", count, labels, resources, ops, logs, calls.Load())
	}
	_, catalog := f.json(t, "GET", "/api/v1/providers", nil, 200, "")
	raw, _ := json.Marshal(catalog)
	if !strings.Contains(string(raw), "gpt-4o-transcribe-diarize") {
		t.Fatal("missing catalog")
	}
	_, settings := f.json(t, "GET", "/api/v1/admin/server-settings", nil, 200, "")
	raw, _ = json.Marshal(settings)
	if strings.Contains(string(raw), "direct-test-secret") {
		t.Fatal("secret leaked")
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestDirectFailureNeverRetriesAndRequiresNewVersionConfirmation(t *testing.T) {
	f, calls := directFixture(t, func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); w.WriteHeader(429) })
	rid := directRecording(t, f, false)
	f.run(t, "prepare")
	j := createDirect(t, f, rid)
	f.a.execute(context.Background(), j)
	assertDirectJob(t, f, j, "failed", "direct_rate_limited")
	f.json(t, "POST", "/api/v1/jobs/"+j.ID+"/retry", map[string]any{}, 409, "")
	_, listing := f.json(t, "GET", "/api/v1/jobs?recording_id="+rid, nil, 200, "")
	for _, item := range listing["items"].([]any) {
		v := item.(map[string]any)
		if v["id"] == j.ID && (v["retry_allowed"] != false || v["duplicate_risk"] != true) {
			t.Fatal(v)
		}
	}
	f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", directOptions(), 409, uuid.NewString())
	confirmed := map[string]any{}
	raw, _ := json.Marshal(directOptions())
	json.Unmarshal(raw, &confirmed)
	confirmed["acknowledge_duplicate_risk"] = true
	key := uuid.NewString()
	_, one := f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", confirmed, 202, key)
	_, two := f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", confirmed, 202, key)
	if one["transcription"].(map[string]any)["id"] != two["transcription"].(map[string]any)["id"] || calls.Load() != 1 {
		t.Fatal("new version idempotency or replay")
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestDirectRestoreQuarantinesUnconsumedImportIntent(t *testing.T) {
	f, calls := directFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("restored intent was sent") })
	rid := directRecording(t, f, true)
	f.a.Config.RestoreMode = true
	if err := f.a.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.a.Config.RestoreMode = false
	f.run(t, "prepare")
	var id, state, code string
	if err := f.db.QueryRow(context.Background(), "SELECT id,state,error_code FROM jobs WHERE dedupe_key=$1", "auto:"+rid).Scan(&id, &state, &code); err != nil {
		t.Fatal(err)
	}
	if state != "failed" || code != "direct_request_interrupted" || calls.Load() != 0 {
		t.Fatalf("%s/%s calls=%d", state, code, calls.Load())
	}
	f.json(t, "POST", "/api/v1/jobs/"+id+"/retry", map[string]any{}, 409, "")
	f.json(t, "POST", "/api/v1/jobs/"+id+"/resolve", map[string]any{"note": "observed"}, 409, "")
	f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", directOptions(), 409, uuid.NewString())
	var operations int
	f.db.QueryRow(context.Background(), "SELECT count(*) FROM provider_operations WHERE job_id=$1", id).Scan(&operations)
	if operations != 0 {
		t.Fatal("restore invented remote operation")
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestDirectLeaseTakeoverNeverResendsOrPublishesLateResult(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	f, calls := directFixture(t, func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(entered)
		<-release
		io.WriteString(w, `{"segments":[{"text":"late","speaker":"A","start":0,"end":1}]}`)
	})
	rid := directRecording(t, f, false)
	f.run(t, "prepare")
	first := createDirect(t, f, rid)
	done := make(chan error, 1)
	go func() { done <- f.a.transcribe(context.Background(), first) }()
	<-entered
	if _, err := f.db.Exec(context.Background(), "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", first.ID); err != nil {
		t.Fatal(err)
	}
	second, err := NewServer(context.Background(), f.a.Config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	next, err := second.claim(context.Background(), "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	second.execute(context.Background(), next)
	close(release)
	if err := <-done; err == nil {
		t.Fatal("stale result published")
	}
	assertDirectJob(t, f, next, "failed", "direct_request_interrupted")
	var segments, readers, logs int
	if err := f.db.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM segments WHERE transcription_id=$1),(SELECT count(*) FROM blob_read_leases),(SELECT count(*) FROM external_calls WHERE job_id=$2)`, *first.TranscriptionID, first.ID).Scan(&segments, &readers, &logs); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || segments != 0 || readers != 0 || logs != 1 {
		t.Fatalf("calls=%d segments=%d readers=%d logs=%d", calls.Load(), segments, readers, logs)
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestDirectCancelAndDeleteFenceLateResults(t *testing.T) {
	for _, remove := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "delete"}[remove], func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			f, calls := directFixture(t, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				close(entered)
				<-release
				io.WriteString(w, `{"segments":[{"text":"late","speaker":"A","start":0,"end":1}]}`)
			})
			rid := directRecording(t, f, false)
			f.run(t, "prepare")
			j := createDirect(t, f, rid)
			done := make(chan error, 1)
			go func() { done <- f.a.transcribe(context.Background(), j) }()
			<-entered
			if remove {
				f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
			} else {
				f.json(t, "POST", "/api/v1/transcriptions/"+*j.TranscriptionID+"/cancel", map[string]any{}, 202, "")
			}
			close(release)
			if err := <-done; err == nil {
				t.Fatal("late result accepted")
			}
			var segments, readers int
			if err := f.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM segments WHERE transcription_id=$1),(SELECT count(*) FROM blob_read_leases)", *j.TranscriptionID).Scan(&segments, &readers); err != nil {
				t.Fatal(err)
			}
			if segments != 0 || readers != 0 || calls.Load() != 1 {
				t.Fatalf("segments=%d readers=%d calls=%d", segments, readers, calls.Load())
			}
			if !remove {
				f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", directOptions(), 409, uuid.NewString())
			} else {
				if err := f.a.deleteOneRecording(context.Background()); err != nil {
					t.Fatal(err)
				}
				var remains bool
				f.db.QueryRow(context.Background(), "SELECT EXISTS(SELECT 1 FROM recordings WHERE id=$1)", rid).Scan(&remains)
				if remains {
					t.Fatal("direct request blocked local deletion")
				}
			}
		})
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestDirectRestoreAllNonSuccessStates(t *testing.T) {
	for _, state := range []string{"queued", "running", "failed", "cancelled", "succeeded"} {
		t.Run(state, func(t *testing.T) {
			f, calls := directFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("restored request sent") })
			rid := directRecording(t, f, false)
			f.run(t, "prepare")
			j := createDirect(t, f, rid)
			if _, err := f.db.Exec(context.Background(), "UPDATE jobs SET state=$2 WHERE id=$1", j.ID, state); err != nil {
				t.Fatal(err)
			}
			f.a.Config.RestoreMode = true
			if err := f.a.Restore(context.Background()); err != nil {
				t.Fatal(err)
			}
			f.a.Config.RestoreMode = false
			if state == "succeeded" {
				assertDirectJob(t, f, j, "succeeded", "")
			} else {
				assertDirectJob(t, f, j, "failed", "direct_request_interrupted")
				f.json(t, "POST", "/api/v1/jobs/"+j.ID+"/retry", map[string]any{}, 409, "")
				if err := f.a.ReconcileJob(context.Background(), j.ID, uuid.NewString(), "remote", "observed"); err == nil {
					t.Fatal("CLI reconciliation accepted")
				}
			}
			if calls.Load() != 0 {
				t.Fatal("replayed")
			}
		})
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestDirectPermissionRollbackAndResultPersistenceFailure(t *testing.T) {
	for _, boundary := range []string{"external_calls", "segments"} {
		t.Run(boundary, func(t *testing.T) {
			f, calls := directFixture(t, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				io.WriteString(w, `{"segments":[{"text":"ok","speaker":"A","start":0,"end":1}]}`)
			})
			rid := directRecording(t, f, false)
			f.run(t, "prepare")
			j := createDirect(t, f, rid)
			_, err := f.db.Exec(context.Background(), `CREATE FUNCTION reject_direct_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected write failure'; END $$; CREATE TRIGGER reject_direct_test BEFORE INSERT ON `+boundary+` FOR EACH ROW EXECUTE FUNCTION reject_direct_test()`)
			if err != nil {
				t.Fatal(err)
			}
			f.a.execute(context.Background(), j)
			var marked bool
			if err := f.db.QueryRow(context.Background(), "SELECT direct_request_started_at IS NOT NULL FROM jobs WHERE id=$1", j.ID).Scan(&marked); err != nil {
				t.Fatal(err)
			}
			if boundary == "external_calls" {
				if marked || calls.Load() != 0 {
					t.Fatal("rolled-back permission caused request")
				}
				f.json(t, "POST", "/api/v1/jobs/"+j.ID+"/retry", map[string]any{}, 202, "")
			} else {
				if !marked || calls.Load() != 1 {
					t.Fatal("missing consumed permission")
				}
				assertDirectJob(t, f, j, "failed", "direct_result_persistence_failed")
				f.json(t, "POST", "/api/v1/jobs/"+j.ID+"/retry", map[string]any{}, 409, "")
				f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", directOptions(), 409, uuid.NewString())
			}
		})
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestOpenAISTTBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	f, calls := directFixture(t, func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); w.WriteHeader(429) })
	f.a.Config.WebDir = "../../web/dist"
	rid := directRecording(t, f, false)
	f.run(t, "prepare")
	j := createDirect(t, f, rid)
	f.a.execute(context.Background(), j)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "vp", "exec", "e2e", "run", "--config", "e2e.openai-stt.config.ts")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "E2E_TELEMETRY_DISABLED=1", "VOICES_TEST_URL="+f.server.URL, "VOICES_TEST_RECORDING="+rid)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("browser retried paid request")
	}
}
