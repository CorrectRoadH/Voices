package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func referenceFixture(t *testing.T) (*fixture, string, string, []string) {
	t.Helper()
	fakeRemote(t)
	f := setup(t)
	out := f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	job := f.run(t, "transcribe")
	tid := *job.TranscriptionID
	rows, err := f.db.Query(context.Background(), "SELECT id FROM segments WHERE transcription_id=$1 ORDER BY ordinal", tid)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(ids) < 110 {
		t.Fatalf("expected paginated fixture, got %d segments", len(ids))
	}
	return f, rid, tid, ids
}

// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
func TestTranscriptReferences(t *testing.T) {
	f, rid, tid, ids := referenceFixture(t)
	path := "/api/v1/transcriptions/" + tid + "/references"
	_, created := f.json(t, "POST", path, map[string]any{"segment_ids": []string{ids[110], ids[0], ids[2]}}, 201, "")
	code := created["code"].(string)
	if !referenceCode.MatchString(code) {
		t.Fatalf("invalid short code %q", code)
	}
	segments := created["segments"].([]any)
	for i, expected := range []string{ids[0], ids[2], ids[110]} {
		if segments[i].(map[string]any)["id"] != expected {
			t.Fatal("reference must preserve original order")
		}
	}
	get := "/api/v1/references/" + code
	f.json(t, "GET", get, nil, 200, "")
	other := anotherAccount(t, f, "ref_other")
	other.json(t, "GET", get, nil, 404, "")
	other.json(t, "POST", path, map[string]any{"segment_ids": []string{ids[0]}}, 404, "")
	response, err := http.Get(f.server.URL + get)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatalf("anonymous status %d", response.StatusCode)
	}
	for _, code := range []string{"bad", "000000000000"} {
		f.json(t, "GET", "/api/v1/references/"+code, nil, 404, "")
	}
	for _, values := range [][]string{nil, {}, {"not-a-uuid"}, {ids[0], ids[0]}, {ids[0], strings.ToUpper(ids[0])}, {uuid.NewString()}, ids[:101]} {
		_, invalid := f.json(t, "POST", path, map[string]any{"segment_ids": values}, 400, "")
		if invalid["error"].(map[string]any)["code"] != "invalid_reference" {
			t.Fatal(invalid)
		}
	}
	// Another historical version must never be silently substituted or combined.
	f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", options(), 202, uuid.NewString())
	second := f.run(t, "transcribe")
	var secondID string
	if err := f.db.QueryRow(context.Background(), "SELECT id FROM segments WHERE transcription_id=$1 ORDER BY ordinal LIMIT 1", *second.TranscriptionID).Scan(&secondID); err != nil {
		t.Fatal(err)
	}
	f.json(t, "POST", path, map[string]any{"segment_ids": []string{ids[0], secondID}}, 400, "")
	f.json(t, "PATCH", "/api/v1/segments/"+ids[0], map[string]any{"revision": 1, "edited_text": "edited after copying", "assignment_mode": "unknown"}, 200, "")
	_, reopened := f.json(t, "GET", get, nil, 200, "")
	if reopened["transcription_id"] != tid || len(reopened["segments"].([]any)) != 3 || reopened["segments"].([]any)[0].(map[string]any)["text"] != "edited after copying" {
		t.Fatal(reopened)
	}
	// Recreate the app to prove references belong to PostgreSQL, not process memory.
	secondServer := httptest.NewServer(New(f.a.Config, f.db).Handler())
	defer secondServer.Close()
	secondFixture := &fixture{server: secondServer, client: f.client}
	secondFixture.json(t, "GET", get, nil, 200, "")
	savedCSRF := f.csrf
	f.csrf = ""
	f.json(t, "POST", path, map[string]any{"segment_ids": []string{ids[0]}}, 403, "")
	f.csrf = savedCSRF
	f.a.Config.RestoreMode = true
	f.json(t, "POST", path, map[string]any{"segment_ids": []string{ids[0]}}, 409, "")
	f.json(t, "GET", get, nil, 200, "")
	f.a.Config.RestoreMode = false
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	f.json(t, "GET", get, nil, 404, "")
	f.json(t, "POST", path, map[string]any{"segment_ids": []string{ids[0]}}, 404, "")
	for range 4 { // Two remote resources per historical version.
		if err := f.a.maintenance(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := f.db.QueryRow(context.Background(), "SELECT count(*) FROM transcript_references WHERE code=$1", code).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("deleted transcript retained reference")
	}
}

// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md#stability
func TestReferenceCreateWaitsForDeletion(t *testing.T) {
	f, rid, tid, ids := referenceFixture(t)
	ctx := context.Background()
	tx, err := f.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	// Hold the same lock as deleteRecording before the HTTP create obtains it.
	if _, err := tx.Exec(ctx, "UPDATE recordings SET state='deleting',active_transcription_id=NULL WHERE id=$1", rid); err != nil {
		t.Fatal(err)
	}
	result := make(chan int, 1)
	go func() {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		body, _ := json.Marshal(map[string]any{"segment_ids": []string{ids[0]}})
		req, _ := http.NewRequestWithContext(ctx, "POST", f.server.URL+"/api/v1/transcriptions/"+tid+"/references", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", f.csrf)
		resp, err := f.client.Do(req)
		if err != nil {
			result <- 0
			return
		}
		defer resp.Body.Close()
		result <- resp.StatusCode
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting bool
		if err := f.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT r.state FROM recordings%')").Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("create did not wait on recording lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if status := <-result; status != 404 {
		t.Fatalf("create after deletion returned %d", status)
	}
	var count int
	if err := f.db.QueryRow(ctx, "SELECT count(*) FROM transcript_references").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("created a reference to a deleting recording")
	}
}
