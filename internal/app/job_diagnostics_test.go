package app

import (
	"context"
	"github.com/google/uuid"
	"testing"
	"voices/internal/providers"
)

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestJobDiagnosticsAndRecovery(t *testing.T) {
	remote := fakeRemote(t)
	f := setup(t)
	ctx := context.Background()
	remote.uploadStatus.Store(503)
	out := f.upload(t, wav(20), map[string]any{"title": "关联录音", "auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	j, err := f.a.claim(ctx, "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	f.a.execute(ctx, j)
	_, list := f.json(t, "GET", "/api/v1/jobs?recording_id="+rid, nil, 200, "")
	var found map[string]any
	for _, item := range list["items"].([]any) {
		v := item.(map[string]any)
		if v["id"] == j.ID {
			found = v
		}
	}
	if found == nil || found["state"] != "uncertain" || found["retry_allowed"] != false {
		t.Fatalf("job=%v", found)
	}
	if found["recording_title"] != "关联录音" {
		t.Fatalf("recording title missing: %v", found)
	}
	detail := found["error_detail"].(map[string]any)
	if detail["reason"] != "http_status" || detail["http_status"] != float64(503) {
		t.Fatalf("detail=%v", detail)
	}
	f.json(t, "POST", "/api/v1/jobs/"+j.ID+"/retry", map[string]any{}, 409, "")
	f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", options(), 409, uuid.NewString())
	remote.uploadStatus.Store(401)
	opts := struct {
		providers.Options
		Acknowledge bool `json:"acknowledge_duplicate_risk"`
	}{options(), true}
	f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", opts, 202, uuid.NewString())
	next, err := f.a.claim(ctx, "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	f.a.execute(ctx, next)
	_, failures := f.json(t, "GET", "/api/v1/jobs?recording_id="+rid+"&state=failed,uncertain", nil, 200, "")
	if len(failures["items"].([]any)) != 2 {
		t.Fatalf("failure filter must include both failed attempts: %v", failures)
	}
	_, failures = f.json(t, "GET", "/api/v1/jobs?recording_id="+rid+"&state=failed", nil, 200, "")
	if len(failures["items"].([]any)) != 1 {
		t.Fatalf("single-state API filter changed: %v", failures)
	}
	_, list = f.json(t, "GET", "/api/v1/jobs?recording_id="+rid, nil, 200, "")
	for _, item := range list["items"].([]any) {
		v := item.(map[string]any)
		if v["id"] == next.ID && v["retry_allowed"] != true {
			t.Fatalf("safe upload retry hidden: %v", v)
		}
	}
	f.a.Config.RestoreMode = true
	f.json(t, "POST", "/api/v1/jobs/"+next.ID+"/retry", map[string]any{}, 409, "")
	f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", opts, 409, uuid.NewString())
	f.a.Config.RestoreMode = false
	remote.uploadStatus.Store(0)
	f.json(t, "POST", "/api/v1/jobs/"+next.ID+"/retry", map[string]any{}, 202, "")
	var cleared bool
	if err := f.db.QueryRow(ctx, "SELECT error_detail IS NULL AND error_code IS NULL FROM jobs WHERE id=$1", next.ID).Scan(&cleared); err != nil || !cleared {
		t.Fatalf("diagnostic not cleared: %v", err)
	}
	f.run(t, "transcribe")
	var oldState string
	f.db.QueryRow(ctx, "SELECT state FROM jobs WHERE id=$1", j.ID).Scan(&oldState)
	if oldState != "uncertain" || remote.uploads.Load() != 3 || remote.submits.Load() != 1 {
		t.Fatalf("old job replayed or lost: %s uploads=%d submits=%d", oldState, remote.uploads.Load(), remote.submits.Load())
	}
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	_, list = f.json(t, "GET", "/api/v1/jobs?recording_id="+rid, nil, 200, "")
	for _, item := range list["items"].([]any) {
		if item.(map[string]any)["recording_title"] != nil {
			t.Fatal("deleting recording must not have an available title link")
		}
	}
}
