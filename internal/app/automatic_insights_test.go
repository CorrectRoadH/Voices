package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func configureAutomaticInsights(t *testing.T, f *fixture, fail bool) *atomic.Int32 {
	t.Helper()
	calls := new(atomic.Int32)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		content := string(jsonBytes(map[string]any{"summary": "自动摘要", "chapters": []any{map[string]any{"segment_id": "s1", "title": "自动目录"}}}))
		writeJSON(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": content}}}})
	}))
	t.Cleanup(remote.Close)
	f.a.Config.LLMBaseURL, f.a.Config.LLMModel = remote.URL, "automatic-model"
	seedFixtureSettings(t, f)
	return calls
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestAutomaticInsightsAfterTranscription(t *testing.T) {
	for _, direct := range []bool{false, true} {
		name := "async"
		if direct {
			name = "direct"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			var f *fixture
			if direct {
				f, _ = directFixture(t, func(w http.ResponseWriter, r *http.Request) {
					writeJSON(w, 200, map[string]any{"segments": []any{map[string]any{"text": "正文", "speaker": "A", "start": 0, "end": 1}}})
				})
			} else {
				fakeRemote(t)
				f = setup(t)
			}
			calls := configureAutomaticInsights(t, f, false)
			chosen := options()
			if direct {
				chosen = directOptions()
			}
			meta := map[string]any{"auto_transcribe": true, "transcription_options": chosen}
			audio := wav(20)
			f.upload(t, audio, meta, uuid.NewString(), 201)
			f.run(t, "prepare")
			j := f.run(t, "transcribe")
			path := "/api/v1/transcriptions/" + *j.TranscriptionID + "/insights"
			_, queued := f.json(t, "GET", path, nil, 200, "")
			if queued["insight"] == nil || queued["insight"].(map[string]any)["state"] != "queued" || calls.Load() != 0 {
				t.Fatal("successful publication must queue, not call LLM inline", queued, calls.Load())
			}
			// An explicit request cannot replace an automatically queued generation.
			f.json(t, "POST", path, map[string]any{}, 409, uuid.NewString())
			// Later configuration changes must not change the accepted snapshot.
			f.a.Config.LLMBaseURL, f.a.Config.LLMModel = "http://127.0.0.1:1", "changed"
			seedFixtureSettings(t, f)
			second := New(f.a.Config, f.db)
			work, err := second.claimInsight(ctx)
			if err != nil {
				t.Fatal(err)
			}
			second.executeInsight(ctx, work)
			_, result := f.json(t, "GET", path, nil, 200, "")
			if result["insight"].(map[string]any)["state"] != "succeeded" || calls.Load() != 1 {
				t.Fatal(result, calls.Load())
			}
			f.upload(t, audio, meta, uuid.NewString(), 200)
			if _, err = second.claimInsight(ctx); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatal("duplicate generation", err)
			}
			var logs int
			var cleared bool
			if err = f.db.QueryRow(ctx, `SELECT input_json IS NULL AND llm_config_json IS NULL FROM transcription_insights WHERE transcription_id=$1`, *j.TranscriptionID).Scan(&cleared); err != nil || !cleared {
				t.Fatal("retained snapshots", err)
			}
			if err = f.db.QueryRow(ctx, `SELECT count(*) FROM external_calls WHERE transcription_id=$1 AND operation='generate_insights' AND state='succeeded'`, *j.TranscriptionID).Scan(&logs); err != nil || logs != 1 {
				t.Fatal("missing automatic call log", logs, err)
			}
		})
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestAutomaticInsightsUnconfiguredDoesNotBackfill(t *testing.T) {
	fakeRemote(t)
	f := setup(t)
	f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	f.run(t, "prepare")
	j := f.run(t, "transcribe")
	path := "/api/v1/transcriptions/" + *j.TranscriptionID + "/insights"
	_, initial := f.json(t, "GET", path, nil, 200, "")
	if initial["insight"] != nil {
		t.Fatal(initial)
	}
	calls := configureAutomaticInsights(t, f, false)
	_, later := f.json(t, "GET", path, nil, 200, "")
	if later["insight"] != nil || later["configured"] != true {
		t.Fatal(later)
	}
	if _, err := f.a.claimInsight(context.Background()); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("backfilled old version", err)
	}
	if calls.Load() != 0 {
		t.Fatal("unexpected request")
	}
	f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestAutomaticInsightsInputLimitsPreserveTranscription(t *testing.T) {
	for _, tc := range []struct{ text, code string }{{"", "empty_transcript"}, {strings.Repeat("x", 200001), "transcript_too_large"}} {
		t.Run(tc.code, func(t *testing.T) {
			f, _ := directFixture(t, func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, 200, map[string]any{"segments": []any{map[string]any{"text": tc.text, "speaker": "A", "start": 0, "end": 1}}})
			})
			calls := configureAutomaticInsights(t, f, false)
			directRecording(t, f, true)
			f.run(t, "prepare")
			j := f.run(t, "transcribe")
			_, result := f.json(t, "GET", "/api/v1/transcriptions/"+*j.TranscriptionID+"/insights", nil, 200, "")
			v, ok := result["insight"].(map[string]any)
			if !ok || v["state"] != "failed" || v["error_code"] != tc.code {
				t.Fatal(result)
			}
			if _, err := f.a.claimInsight(context.Background()); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatal(err)
			}
			var cleared bool
			if err := f.db.QueryRow(context.Background(), `SELECT input_json IS NULL AND llm_config_json IS NULL FROM transcription_insights WHERE transcription_id=$1`, *j.TranscriptionID).Scan(&cleared); err != nil || !cleared || calls.Load() != 0 {
				t.Fatal("invalid input must not be sent or retained", err)
			}
		})
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestAutomaticInsightsFailureAndRestoreDoNotReplay(t *testing.T) {
	for _, restore := range []bool{false, true} {
		name := "failure"
		if restore {
			name = "restore"
		}
		t.Run(name, func(t *testing.T) {
			fakeRemote(t)
			f := setup(t)
			calls := configureAutomaticInsights(t, f, true)
			f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
			f.run(t, "prepare")
			j := f.run(t, "transcribe")
			ctx := context.Background()
			if restore {
				f.a.Config.RestoreMode = true
				if err := f.a.Restore(ctx); err != nil {
					t.Fatal(err)
				}
				f.a.Config.RestoreMode = false
			} else {
				work, err := f.a.claimInsight(ctx)
				if err != nil {
					t.Fatal(err)
				}
				f.a.executeInsight(ctx, work)
			}
			if _, err := New(f.a.Config, f.db).claimInsight(ctx); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatal("replayed", err)
			}
			wantCalls := int32(1)
			if restore {
				wantCalls = 0
			}
			if calls.Load() != wantCalls {
				t.Fatal(calls.Load())
			}
			_, result := f.json(t, "GET", "/api/v1/transcriptions/"+*j.TranscriptionID+"/insights", nil, 200, "")
			if result["insight"] == nil || result["insight"].(map[string]any)["state"] != "failed" {
				t.Fatal(result)
			}
		})
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestAutomaticInsightsRestoredUnpublishedTasksStaySuppressed(t *testing.T) {
	for _, prepared := range []bool{false, true} {
		name := "before_prepare"
		if prepared {
			name = "before_publish"
		}
		t.Run(name, func(t *testing.T) {
			fakeRemote(t)
			f := setup(t)
			calls := configureAutomaticInsights(t, f, false)
			out := f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
			rid := out["recording"].(map[string]any)["id"].(string)
			ctx := context.Background()
			if prepared {
				f.run(t, "prepare")
			}
			f.a.Config.RestoreMode = true
			if err := f.a.Restore(ctx); err != nil {
				t.Fatal(err)
			}
			f.a.Config.RestoreMode = false
			if prepared {
				var jid string
				if err := f.db.QueryRow(ctx, "SELECT id FROM jobs WHERE kind='transcribe'").Scan(&jid); err != nil {
					t.Fatal(err)
				}
				for _, kind := range []string{"upload", "submit"} {
					var op string
					if err := f.db.QueryRow(ctx, "SELECT id FROM provider_operations WHERE job_id=$1 AND kind=$2", jid, kind).Scan(&op); err != nil {
						t.Fatal(err)
					}
					if err := f.a.ReconcileJob(ctx, jid, op, "restored-"+kind, "已核对远端记录"); err != nil {
						t.Fatal(err)
					}
				}
			} else {
				f.run(t, "prepare")
			}
			j := f.run(t, "transcribe")
			path := "/api/v1/transcriptions/" + *j.TranscriptionID + "/insights"
			_, old := f.json(t, "GET", path, nil, 200, "")
			if old["insight"] != nil || calls.Load() != 0 {
				t.Fatal("restored old task generated insights", old)
			}
			if _, err := f.a.claimInsight(ctx); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatal(err)
			}
			// A new, explicit version is eligible even on a restored recording.
			f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", options(), 202, uuid.NewString())
			fresh := f.run(t, "transcribe")
			_, next := f.json(t, "GET", "/api/v1/transcriptions/"+*fresh.TranscriptionID+"/insights", nil, 200, "")
			if next["insight"] == nil || next["insight"].(map[string]any)["state"] != "queued" {
				t.Fatal("new version incorrectly suppressed", next)
			}
			// The old version remains available for an explicitly requested generation.
			f.json(t, "POST", path, map[string]any{}, 202, uuid.NewString())
		})
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestAutomaticInsightsDatabaseFailureDoesNotResendDirectSTT(t *testing.T) {
	f, sttCalls := directFixture(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"segments": []any{map[string]any{"text": "正文", "speaker": "A", "start": 0, "end": 1}}})
	})
	llmCalls := configureAutomaticInsights(t, f, false)
	directRecording(t, f, true)
	f.run(t, "prepare")
	ctx := context.Background()
	_, err := f.db.Exec(ctx, `CREATE FUNCTION reject_automatic_insight() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected queue failure'; END $$; CREATE TRIGGER reject_automatic_insight BEFORE INSERT ON transcription_insights FOR EACH ROW EXECUTE FUNCTION reject_automatic_insight()`)
	if err != nil {
		t.Fatal(err)
	}
	j, err := f.a.claim(ctx, "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	f.a.execute(ctx, j)
	assertDirectJob(t, f, j, "failed", "direct_result_persistence_failed")
	if _, err = f.a.claim(ctx, "transcribe"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("replayed direct STT", err)
	}
	var segments, queued int
	if err = f.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM segments),(SELECT count(*) FROM transcription_insights)`).Scan(&segments, &queued); err != nil || segments != 0 || queued != 0 {
		t.Fatal("partial publication", err, segments, queued)
	}
	if sttCalls.Load() != 1 || llmCalls.Load() != 0 {
		t.Fatal("unexpected external calls", sttCalls.Load(), llmCalls.Load())
	}
}
