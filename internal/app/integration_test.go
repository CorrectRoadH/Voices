package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"voices/internal/persistence"
	"voices/internal/providers"
	"voices/internal/storage"
)

type fixture struct {
	a      *App
	server *httptest.Server
	client *http.Client
	csrf   string
	db     *pgxpool.Pool
}

func setup(t *testing.T) *fixture { return setupAccountFixture(t, true) }
func setupAccountFixture(t *testing.T, registered bool) *fixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is required for PostgreSQL integration tests")
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Fatal("ffmpeg required for real media acceptance")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := "voices_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close(); admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); admin.Close() })
	if err := persistence.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	c := Config{DatabaseURL: dsn, PublicBaseURL: "http://localhost", TempDir: t.TempDir(), MaxUploadBytes: 2 << 30, SonioxKey: "test-only-key", TranscriptionConcurrency: 2, PrepareConcurrency: 1, HTTPTimeout: 2 * time.Second}
	a := New(c, db, providers.NewSoniox(c.SonioxKey), providers.NewAssemblyAI(""))
	server := httptest.NewServer(a.Handler())
	a.Config.PublicBaseURL = server.URL
	t.Cleanup(server.Close)
	jar, _ := cookiejar.New(nil)
	f := &fixture{a: a, server: server, client: &http.Client{Jar: jar}, db: db}
	seedFixtureSettings(t, f)
	if !registered {
		return f
	}
	_, result := f.json(t, "POST", "/api/v1/users", map[string]any{"email": "tester@example.test", "display_name": "Tester", "password": "acceptance-password"}, 201, "")
	f.csrf = result["csrf_token"].(string)
	if _, err := f.db.Exec(ctx, "UPDATE instance_settings SET site_setup_completed=true WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *fixture) request(t *testing.T, method, path string, body io.Reader, ctype string, status int, key string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, f.server.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	req.Header.Set("X-CSRF-Token", f.csrf)
	resp, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != status {
		t.Fatalf("%s %s status %d want %d: %s", method, path, resp.StatusCode, status, raw)
	}
	return resp, raw
}
func (f *fixture) json(t *testing.T, method, path string, body any, status int, key string) (*http.Response, map[string]any) {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(jsonBytes(body))
	}
	resp, raw := f.request(t, method, path, r, "application/json", status, key)
	result := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatalf("JSON response: %v: %s", err, raw)
		}
	}
	return resp, result
}
func wav(seconds int) []byte {
	samples := seconds * 16000
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+samples*2))
	b.WriteString("WAVEfmt ")
	binary.Write(&b, binary.LittleEndian, uint32(16))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint32(16000))
	binary.Write(&b, binary.LittleEndian, uint32(32000))
	binary.Write(&b, binary.LittleEndian, uint16(2))
	binary.Write(&b, binary.LittleEndian, uint16(16))
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(samples*2))
	b.Write(make([]byte, samples*2))
	return b.Bytes()
}
func (f *fixture) upload(t *testing.T, data []byte, meta any, key string, status int) map[string]any {
	t.Helper()
	var b bytes.Buffer
	m := multipart.NewWriter(&b)
	p, _ := m.CreateFormField("metadata")
	p.Write(jsonBytes(meta))
	file, _ := m.CreateFormFile("file", "meeting.wav")
	file.Write(data)
	m.Close()
	_, raw := f.request(t, "POST", "/api/v1/recordings", &b, m.FormDataContentType(), status, key)
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func (f *fixture) run(t *testing.T, kind string) job {
	t.Helper()
	j, err := f.a.claim(context.Background(), kind)
	if err != nil {
		t.Fatalf("claim %s: %v", kind, err)
	}
	f.a.execute(context.Background(), j)
	var state, code string
	if err := f.db.QueryRow(context.Background(), "SELECT state,COALESCE(error_code,'') FROM jobs WHERE id=$1", j.ID).Scan(&state, &code); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" {
		t.Fatalf("job %s state=%s error=%s", kind, state, code)
	}
	return j
}
func options() providers.Options {
	return providers.Options{Provider: "soniox", Model: "stt-async-v5", LanguageMode: "single", Languages: []string{"zh"}, Diarization: true}
}

type rewriteTransport struct {
	target *url.URL
	base   http.RoundTripper
}

func (r rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host != "api.soniox.com" {
		return r.base.RoundTrip(req)
	}
	copy := req.Clone(req.Context())
	u := *req.URL
	u.Scheme = r.target.Scheme
	u.Host = r.target.Host
	copy.URL = &u
	return r.base.RoundTrip(copy)
}

type remoteFake struct {
	uploads, submits, deletes atomic.Int32
	uncertain                 atomic.Bool
	pollFailures              atomic.Int32
}

func fakeRemote(t *testing.T) *remoteFake {
	t.Helper()
	remote := &remoteFake{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/v1/files":
			io.Copy(io.Discard, r.Body)
			id := remote.uploads.Add(1)
			fmt.Fprintf(w, `{"id":"file-%d"}`, id)
		case r.Method == "POST" && r.URL.Path == "/v1/transcriptions":
			id := remote.submits.Add(1)
			if remote.uncertain.Load() {
				w.WriteHeader(503)
				return
			}
			fmt.Fprintf(w, `{"id":"transcript-%d"}`, id)
		case r.Method == "DELETE":
			remote.deletes.Add(1)
			w.WriteHeader(204)
		case strings.HasSuffix(r.URL.Path, "/transcript"):
			tokens := []map[string]any{}
			for i := 0; i < 130; i++ {
				speaker := "A"
				if i%2 == 1 {
					speaker = "B"
				}
				tokens = append(tokens, map[string]any{"text": fmt.Sprintf("句子%d。", i), "start_ms": i * 100, "end_ms": i*100 + 80, "speaker": speaker})
			}
			writeJSON(w, 200, map[string]any{"tokens": tokens})
		case r.Method == "GET":
			if remote.pollFailures.Load() > 0 {
				remote.pollFailures.Add(-1)
				w.WriteHeader(503)
				return
			}
			io.WriteString(w, `{"status":"completed"}`)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	old := http.DefaultTransport
	target, _ := url.Parse(srv.URL)
	http.DefaultTransport = rewriteTransport{target, old}
	t.Cleanup(func() { http.DefaultTransport = old })
	return remote
}

// @use-case docs/feature/recording-library/use-case/import-audio.md
func TestHTTPImportCrossInstanceRangesAndIdempotency(t *testing.T) {
	f := setup(t)
	data := wav(80)
	key := uuid.NewString()
	meta := map[string]any{"title": "会议", "auto_transcribe": false}
	out := f.upload(t, data, meta, key, 201)
	recording := out["recording"].(map[string]any)
	rid := recording["id"].(string)
	f.upload(t, data, meta, key, 200)
	f.upload(t, data, meta, uuid.NewString(), 200)
	f.upload(t, data, map[string]any{"title": "changed", "auto_transcribe": false}, key, 409)
	var count int
	f.db.QueryRow(context.Background(), "SELECT count(*) FROM recordings").Scan(&count)
	if count != 1 {
		t.Fatalf("recordings=%d", count)
	}
	// A fresh instance with a fresh temporary directory owns all subsequent work.
	bcfg := f.a.Config
	bcfg.TempDir = t.TempDir()
	b := New(bcfg, f.db, providers.NewSoniox("test-only-key"))
	bs := httptest.NewServer(b.Handler())
	defer bs.Close()
	b.Config.PublicBaseURL = bs.URL
	f.a = b
	f.server = bs
	f.run(t, "prepare")
	_, session := f.json(t, "GET", "/api/v1/session", nil, 200, "")
	if session["csrf_token"] != f.csrf {
		t.Fatal("session did not survive replica replacement")
	}
	resp, all := f.request(t, "GET", "/api/v1/recordings/"+rid+"/audio", nil, "", 200, "")
	if len(all) < storage.ChunkSize+1024 {
		t.Fatal("fixture does not cross playback chunk boundary")
	}
	if resp.Header.Get("Content-Type") != "audio/mpeg" {
		t.Fatal("playback MIME")
	}
	for _, tc := range []struct {
		rangeHeader string
		start, end  int
		status      int
	}{{"bytes=1048500-1048700", 1048500, 1048701, 206}, {"bytes=-17", len(all) - 17, len(all), 206}, {"bytes=100-", 100, len(all), 206}, {"bytes=999999999-", 0, 0, 416}, {"bytes=0-1,5-6", 0, len(all), 200}} {
		req, _ := http.NewRequest("GET", bs.URL+"/api/v1/recordings/"+rid+"/audio", nil)
		req.Header.Set("Range", tc.rangeHeader)
		resp, err := f.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != tc.status {
			t.Fatalf("range %s=%d", tc.rangeHeader, resp.StatusCode)
		}
		if tc.status != 416 && !bytes.Equal(got, all[tc.start:tc.end]) {
			t.Fatalf("range bytes mismatch: %s", tc.rangeHeader)
		}
	}
	req, _ := http.NewRequest("GET", bs.URL+"/api/v1/recordings/"+rid+"/audio", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("anonymous playback=%d", resp.StatusCode)
	}
	f.json(t, "PATCH", "/api/v1/recordings/"+rid, map[string]any{"revision": 2, "title": "更新标题"}, 200, "")
	f.json(t, "PATCH", "/api/v1/recordings/"+rid, map[string]any{"revision": 2, "title": "覆盖"}, 409, "")
}

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestTranscriptionLifecycleVersionsAndEdits(t *testing.T) {
	remote := fakeRemote(t)
	f := setup(t)
	out := f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	// Defaults change after import cannot change the captured authorization/options.
	changed := options()
	changed.LanguageMode = "auto"
	changed.Languages = []string{}
	f.json(t, "PATCH", "/api/v1/settings", Settings{DefaultTranscription: &changed}, 200, "")
	f.run(t, "prepare")
	j := f.run(t, "transcribe")
	tid := *j.TranscriptionID
	_, version := f.json(t, "GET", "/api/v1/transcriptions/"+tid, nil, 200, "")
	if version["options"].(map[string]any)["language_mode"] != "single" {
		t.Fatal("import snapshot changed")
	}
	if remote.submits.Load() != 1 {
		t.Fatal("submit count")
	}
	_, list := f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/segments?limit=100", nil, 200, "")
	items := list["items"].([]any)
	first := items[0].(map[string]any)
	sid := first["id"].(string)
	f.json(t, "PATCH", "/api/v1/segments/"+sid, map[string]any{"revision": 1, "edited_text": "校正 [文本]"}, 200, "")
	f.json(t, "PATCH", "/api/v1/segments/"+sid, map[string]any{"revision": 1, "edited_text": "覆盖"}, 409, "")
	_, person := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "小林"}, 201, uuid.NewString())
	labels := version["speaker_labels"].([]any)
	label := labels[0].(map[string]any)
	f.json(t, "PATCH", "/api/v1/speaker-labels/"+label["id"].(string), map[string]any{"revision": 1, "person_id": person["id"]}, 200, "")
	_, byPerson := f.json(t, "GET", "/api/v1/recordings?person_id="+person["id"].(string), nil, 200, "")
	if len(byPerson["items"].([]any)) != 1 {
		t.Fatal("person filter")
	}
	_, secondPage := f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/segments?limit=100&cursor="+list["next_cursor"].(string), nil, 200, "")
	anchor := secondPage["items"].([]any)[20].(map[string]any)["id"].(string)
	_, window := f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/segments?limit=10&anchor_id="+anchor, nil, 200, "")
	found := false
	for _, item := range window["items"].([]any) {
		if item.(map[string]any)["id"] == anchor {
			found = true
		}
	}
	if !found || window["previous_cursor"] == nil {
		t.Fatal("anchor window")
	}
	_, raw := f.request(t, "GET", "/api/v1/transcriptions/"+tid+"/export?format=txt", nil, "", 200, "")
	if !bytes.Contains(raw, []byte("校正 [文本]")) {
		t.Fatal("export omitted edits")
	}
	f.request(t, "GET", "/api/v1/transcriptions/"+tid+"/export?format=srt", nil, "", 200, "")
	f.json(t, "PATCH", "/api/v1/segments/"+sid, map[string]any{"revision": 2, "start_ms": nil, "end_ms": nil}, 200, "")
	f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/export?format=srt", nil, 422, "")
	f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", options(), 202, uuid.NewString())
	second := f.run(t, "transcribe")
	_, rec := f.json(t, "GET", "/api/v1/recordings/"+rid, nil, 200, "")
	if rec["active_transcription_id"] != tid {
		t.Fatal("rerun replaced active version")
	}
	f.json(t, "GET", "/api/v1/transcriptions/"+*second.TranscriptionID+"/segments?anchor_id="+sid, nil, 404, "")
	_, old := f.json(t, "GET", "/api/v1/segments/"+sid, nil, 200, "")
	if old["text"] != "校正 [文本]" {
		t.Fatal("old version link changed")
	}
	// Cross-version speaker assignments must be rejected by the real database FK.
	_, newVersion := f.json(t, "GET", "/api/v1/transcriptions/"+*second.TranscriptionID, nil, 200, "")
	newLabel := newVersion["speaker_labels"].([]any)[0].(map[string]any)["id"]
	f.json(t, "PATCH", "/api/v1/segments/"+sid, map[string]any{"revision": 3, "assignment_mode": "label", "assigned_label_id": newLabel}, 400, "")
}

// @use-case docs/feature/stateless-deployment/use-case/replace-instance.md
func TestUncertainRequestObservationLateReceiptAndDeletion(t *testing.T) {
	remote := fakeRemote(t)
	remote.uncertain.Store(true)
	f := setup(t)
	out := f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	j, err := f.a.claim(context.Background(), "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	f.a.execute(context.Background(), j)
	var state, op string
	f.db.QueryRow(context.Background(), "SELECT state FROM jobs WHERE id=$1", j.ID).Scan(&state)
	if state != "uncertain" {
		t.Fatalf("job state=%s", state)
	}
	f.db.QueryRow(context.Background(), "SELECT id FROM provider_operations WHERE job_id=$1 AND kind='submit'", j.ID).Scan(&op)
	f.json(t, "POST", "/api/v1/jobs/"+j.ID+"/retry", map[string]any{}, 409, "")
	f.json(t, "POST", "/api/v1/jobs/"+j.ID+"/resolve", map[string]any{"note": "控制台暂未查到"}, 200, "")
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	if err := f.a.maintenance(context.Background()); err != nil {
		t.Fatal(err)
	}
	var exists bool
	f.db.QueryRow(context.Background(), "SELECT EXISTS(SELECT 1 FROM recordings WHERE id=$1)", rid).Scan(&exists)
	if !exists {
		t.Fatal("observation incorrectly unblocked hard deletion")
	}
	// The old executor may register a late receipt, but its generation cannot publish results.
	err = persistence.Transaction(context.Background(), f.db, func(tx pgx.Tx) error {
		return registerResourceTx(context.Background(), tx, op, "soniox", providers.Resource{ID: "transcript-1", Kind: "transcription"})
	})
	if err != nil {
		t.Fatal(err)
	}
	err = persistence.Transaction(context.Background(), f.db, func(tx pgx.Tx) error { return f.a.fence(context.Background(), tx, j) })
	if err != storage.ErrLease {
		t.Fatalf("old lease accepted: %v", err)
	}
	for i := 0; i < 4; i++ {
		if err := f.a.maintenance(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	f.db.QueryRow(context.Background(), "SELECT EXISTS(SELECT 1 FROM recordings WHERE id=$1)", rid).Scan(&exists)
	if exists {
		t.Fatal("known resources were not cleaned")
	}
	if remote.submits.Load() != 1 {
		t.Fatal("duplicate paid submit")
	}
}

// @use-case docs/feature/stateless-deployment/use-case/replace-instance.md
func TestRestoreQuarantinesQueuedAndFailedWithoutOperations(t *testing.T) {
	remote := fakeRemote(t)
	f := setup(t)
	out := f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", options(), 202, uuid.NewString())
	f.db.Exec(context.Background(), "UPDATE jobs SET state='failed' WHERE kind='transcribe' AND id=(SELECT id FROM jobs WHERE kind='transcribe' ORDER BY id LIMIT 1)")
	f.a.Config.RestoreMode = true
	if err := f.a.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	var count int
	f.db.QueryRow(context.Background(), "SELECT count(*) FROM jobs WHERE kind='transcribe' AND state='restore_hold'").Scan(&count)
	if count != 2 {
		t.Fatalf("held=%d", count)
	}
	f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "恢复时不应写入"}, 409, uuid.NewString())
	f.a.Config.RestoreMode = false
	if _, err := f.a.claim(context.Background(), "transcribe"); err != pgx.ErrNoRows {
		t.Fatalf("restore dispatched: %v", err)
	}
	if remote.submits.Load() != 0 {
		t.Fatal("restore submitted")
	}
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	if err := f.a.maintenance(context.Background()); err != nil {
		t.Fatal(err)
	}
	var exists bool
	f.db.QueryRow(context.Background(), "SELECT EXISTS(SELECT 1 FROM recordings WHERE id=$1)", rid).Scan(&exists)
	if !exists {
		t.Fatal("held tombstone erased")
	}
}

// @use-case docs/feature/stateless-deployment/use-case/replace-instance.md
func TestGlobalJobLimitAndExpiredExecutorCannotPublish(t *testing.T) {
	f := setup(t)
	for i := 1; i <= 3; i++ {
		f.upload(t, wav(19+i), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
		f.run(t, "prepare")
	}
	a := f.a
	b := New(a.Config, f.db, providers.NewSoniox("test-only-key"))
	j1, err := a.claim(context.Background(), "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.claim(context.Background(), "transcribe"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.claim(context.Background(), "transcribe"); err != pgx.ErrNoRows {
		t.Fatalf("global concurrency exceeded: %v", err)
	}
	if _, err := f.db.Exec(context.Background(), "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", j1.ID); err != nil {
		t.Fatal(err)
	}
	replacement, err := b.claim(context.Background(), "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	if replacement.ID != j1.ID || replacement.Generation <= j1.Generation {
		t.Fatal("expired job not reclaimed")
	}
	err = persistence.Transaction(context.Background(), f.db, func(tx pgx.Tx) error { return a.fence(context.Background(), tx, j1) })
	if err != storage.ErrLease {
		t.Fatalf("stale fence=%v", err)
	}
}

// @use-case docs/feature/recording-library/use-case/import-audio.md
func TestAuthCSRFAndInvalidMedia(t *testing.T) {
	f := setup(t)
	csrf := f.csrf
	f.csrf = "wrong"
	f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "test"}, 403, uuid.NewString())
	f.csrf = csrf
	f.upload(t, []byte("not audio"), map[string]any{"auto_transcribe": false}, uuid.NewString(), 422)
	for i := 0; i < 11; i++ {
		req, _ := http.NewRequest("POST", f.server.URL+"/api/v1/session", strings.NewReader(`{"password":"bad"}`))
		resp, err := f.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		expected := 401
		if i == 10 {
			expected = 429
		}
		if resp.StatusCode != expected {
			t.Fatal("rate limit", i, strconv.Itoa(resp.StatusCode))
		}
	}
}

// @use-case docs/feature/stateless-deployment/use-case/replace-instance.md
func TestRestoreKnownReceiptsOnlyResumeOriginalTask(t *testing.T) {
	remote := fakeRemote(t)
	f := setup(t)
	out := f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	_ = out
	f.run(t, "prepare")
	var jid string
	f.db.QueryRow(context.Background(), "SELECT id FROM jobs WHERE kind='transcribe'").Scan(&jid)
	f.a.Config.RestoreMode = true
	if err := f.a.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.a.Config.RestoreMode = false
	var upload, submit string
	f.db.QueryRow(context.Background(), "SELECT id FROM provider_operations WHERE job_id=$1 AND kind='upload'", jid).Scan(&upload)
	f.db.QueryRow(context.Background(), "SELECT id FROM provider_operations WHERE job_id=$1 AND kind='submit'", jid).Scan(&submit)
	f.json(t, "POST", "/api/v1/jobs/"+jid+"/resolve", map[string]any{"operation_id": upload, "remote_id": "restored-file", "note": "已在控制台核对上传记录"}, 403, "")
	if err := f.a.ReconcileJob(context.Background(), jid, upload, "restored-file", "已在控制台核对上传记录"); err != nil {
		t.Fatal(err)
	}
	var state string
	f.db.QueryRow(context.Background(), "SELECT state FROM jobs WHERE id=$1", jid).Scan(&state)
	if state != "restore_hold" {
		t.Fatal("upload receipt alone released quarantine")
	}
	if err := f.a.ReconcileJob(context.Background(), jid, submit, "restored-transcript", "已核对与录音对应的转写记录"); err != nil {
		t.Fatal(err)
	}
	f.run(t, "transcribe")
	if remote.uploads.Load() != 0 || remote.submits.Load() != 0 {
		t.Fatal("restored task created remote resources again")
	}
}

// @use-case docs/feature/stateless-deployment/use-case/replace-instance.md
func TestChunkLeasesDeletionAndAbandonedUpload(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	out := f.upload(t, wav(20), map[string]any{"auto_transcribe": false}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	var blob string
	f.db.QueryRow(ctx, "SELECT blob_id FROM media_assets WHERE recording_id=$1 AND kind='original'", rid).Scan(&blob)
	reader, err := f.a.Blobs.Open(ctx, rid, blob)
	if err != nil {
		t.Fatal(err)
	}
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	if err := f.a.maintenance(ctx); err != nil {
		t.Fatal(err)
	}
	var exists bool
	f.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM blobs WHERE id=$1)", blob).Scan(&exists)
	if !exists {
		t.Fatal("active read lease lost bytes")
	}
	if _, err := reader.Read(make([]byte, 1)); err == nil {
		t.Fatal("reader continued after deletion")
	}
	reader.Close()
	if err := f.a.maintenance(ctx); err != nil {
		t.Fatal(err)
	}
	f.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM blobs WHERE id=$1)", blob).Scan(&exists)
	if exists {
		t.Fatal("released blob not collected")
	}
	var owner string
	if err := f.db.QueryRow(ctx, "SELECT id FROM users WHERE email='tester@example.test'").Scan(&owner); err != nil {
		t.Fatal(err)
	}
	ctx = persistence.WithUserID(ctx, owner)
	writer, err := f.a.Blobs.NewWriter(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteFrom(ctx, strings.NewReader("partial bytes"), nil, 100); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	f.db.Exec(ctx, "UPDATE blobs SET write_lease_until=clock_timestamp()-interval '2 hours' WHERE id=$1", writer.ID)
	err = persistence.Transaction(ctx, f.db, func(tx pgx.Tx) error { return writer.Publish(ctx, tx) })
	if err != storage.ErrLease {
		t.Fatalf("expired writer published: %v", err)
	}
	if err := f.a.collectBlobs(ctx); err != nil {
		t.Fatal(err)
	}
	f.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM blobs WHERE id=$1)", writer.ID).Scan(&exists)
	if exists {
		t.Fatal("abandoned writing blob not collected")
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestReadRetriesStopAndNeverResubmitKnownTask(t *testing.T) {
	remote := fakeRemote(t)
	remote.pollFailures.Store(8)
	f := setup(t)
	f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	f.run(t, "prepare")
	ctx := context.Background()
	var jid string
	for i := 0; i < 8; i++ {
		j, err := f.a.claim(ctx, "transcribe")
		if err != nil {
			t.Fatal(err)
		}
		jid = j.ID
		f.a.execute(ctx, j)
		f.db.Exec(ctx, "UPDATE jobs SET next_run_at=clock_timestamp() WHERE id=$1", jid)
	}
	var state string
	var attempt int
	f.db.QueryRow(ctx, "SELECT state,attempt FROM jobs WHERE id=$1", jid).Scan(&state, &attempt)
	if state != "failed" || attempt != 8 {
		t.Fatalf("retry bound state=%s attempt=%d", state, attempt)
	}
	if remote.submits.Load() != 1 || remote.uploads.Load() != 1 {
		t.Fatal("safe read retries repeated paid creation")
	}
	f.json(t, "POST", "/api/v1/jobs/"+jid+"/retry", map[string]any{}, 202, "")
	f.run(t, "transcribe")
	if remote.submits.Load() != 1 {
		t.Fatal("manual retry repeated submit")
	}
}

// @use-case docs/feature/people/use-case/link-person.md
func TestPersonAssignmentOverridesAndArchive(t *testing.T) {
	fakeRemote(t)
	f := setup(t)
	f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	f.run(t, "prepare")
	j := f.run(t, "transcribe")
	tid := *j.TranscriptionID
	_, person := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "小周", "notes": "采访对象"}, 201, uuid.NewString())
	pid := person["id"].(string)
	_, version := f.json(t, "GET", "/api/v1/transcriptions/"+tid, nil, 200, "")
	labels := version["speaker_labels"].([]any)
	label := labels[0].(map[string]any)
	lid := label["id"].(string)
	f.json(t, "PATCH", "/api/v1/speaker-labels/"+lid, map[string]any{"revision": 1, "person_id": pid}, 200, "")
	_, segments := f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/segments", nil, 200, "")
	first := segments["items"].([]any)[0].(map[string]any)
	sid := first["id"].(string)
	if first["speaker_name"] != "小周" {
		t.Fatal("inherited person name")
	}
	f.json(t, "PATCH", "/api/v1/segments/"+sid, map[string]any{"revision": 1, "assignment_mode": "unknown"}, 200, "")
	_, edited := f.json(t, "GET", "/api/v1/segments/"+sid, nil, 200, "")
	if edited["speaker_name"] != "未知说话人" || edited["person_id"] != nil {
		t.Fatal("explicit unknown did not override source speaker")
	}
	f.json(t, "PATCH", "/api/v1/segments/"+sid, map[string]any{"revision": 2, "assignment_mode": "inherit"}, 200, "")
	f.json(t, "PATCH", "/api/v1/people/"+pid, map[string]any{"revision": 1, "archived": true}, 200, "")
	_, preserved := f.json(t, "GET", "/api/v1/segments/"+sid, nil, 200, "")
	if preserved["speaker_name"] != "小周" {
		t.Fatal("archive removed historical identity")
	}
	f.json(t, "POST", "/api/v1/transcriptions/"+tid+"/speaker-labels", map[string]any{"display_name": "新标签", "person_id": pid}, 400, uuid.NewString())
}

// @use-case docs/feature/recording-library/use-case/import-audio.md
func TestHeldDeletionDoesNotStarveOtherRecordings(t *testing.T) {
	remote := fakeRemote(t)
	remote.uncertain.Store(true)
	f := setup(t)
	first := f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	firstID := first["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	j, err := f.a.claim(context.Background(), "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	f.a.execute(context.Background(), j)
	f.json(t, "DELETE", "/api/v1/recordings/"+firstID, nil, 202, "")
	second := f.upload(t, wav(21), map[string]any{"auto_transcribe": false}, uuid.NewString(), 201)
	secondID := second["recording"].(map[string]any)["id"].(string)
	f.json(t, "DELETE", "/api/v1/recordings/"+secondID, nil, 202, "")
	if err := f.a.maintenance(context.Background()); err != nil {
		t.Fatal(err)
	}
	var exists bool
	f.db.QueryRow(context.Background(), "SELECT EXISTS(SELECT 1 FROM recordings WHERE id=$1)", secondID).Scan(&exists)
	if exists {
		t.Fatal("unrelated held deletion starved eligible recording")
	}
	f.db.QueryRow(context.Background(), "SELECT EXISTS(SELECT 1 FROM recordings WHERE id=$1)", firstID).Scan(&exists)
	if !exists {
		t.Fatal("uncertain tombstone removed")
	}
}

// @use-case docs/feature/people/use-case/link-person.md
func TestBuiltinPeopleVisibilityAndLibraryPeople(t *testing.T) {
	fakeRemote(t)
	f := setup(t)
	_, normal := f.json(t, "GET", "/api/v1/people", nil, 200, "")
	if len(normal["items"].([]any)) != 0 {
		t.Fatal("builtins leaked into ordinary list")
	}
	_, all := f.json(t, "GET", "/api/v1/people?include_builtin=true", nil, 200, "")
	builtins := all["items"].([]any)
	if len(builtins) != 3 {
		t.Fatal("missing builtins", all)
	}
	builtin := builtins[0].(map[string]any)
	f.json(t, "PATCH", "/api/v1/people/"+builtin["id"].(string), map[string]any{"revision": 1, "display_name": "changed"}, 400, "")
	out := f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	job := f.run(t, "transcribe")
	tid := *job.TranscriptionID
	_, version := f.json(t, "GET", "/api/v1/transcriptions/"+tid, nil, 200, "")
	labels := version["speaker_labels"].([]any)
	for _, raw := range labels {
		label := raw.(map[string]any)
		f.json(t, "PATCH", "/api/v1/speaker-labels/"+label["id"].(string), map[string]any{"revision": 1, "person_id": builtin["id"]}, 200, "")
	}
	_, hidden := f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/segments?hide_builtin=true", nil, 200, "")
	if len(hidden["items"].([]any)) != 0 || hidden["next_cursor"] != nil {
		t.Fatal("hidden segments still paginated", hidden)
	}
	_, visible := f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/segments", nil, 200, "")
	if len(visible["items"].([]any)) == 0 {
		t.Fatal("original segments lost")
	}
	_, rec := f.json(t, "GET", "/api/v1/recordings/"+rid, nil, 200, "")
	if len(rec["people"].([]any)) != 0 {
		t.Fatal("builtin in recording people")
	}
	_, person := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "小林"}, 201, uuid.NewString())
	for _, raw := range labels {
		label := raw.(map[string]any)
		f.json(t, "PATCH", "/api/v1/speaker-labels/"+label["id"].(string), map[string]any{"revision": 2, "person_id": person["id"]}, 200, "")
	}
	_, rec = f.json(t, "GET", "/api/v1/recordings/"+rid, nil, 200, "")
	if len(rec["people"].([]any)) != 1 {
		t.Fatal("recording people not deduplicated", rec)
	}
	_, restored := f.json(t, "GET", "/api/v1/transcriptions/"+tid+"/segments?hide_builtin=true", nil, 200, "")
	if len(restored["items"].([]any)) == 0 {
		t.Fatal("reassignment did not reveal segments")
	}
}

// @use-case docs/feature/people/use-case/link-person.md
func TestSelfPersonReplacementAndConflictRollback(t *testing.T) {
	f := setup(t)
	_, first := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "甲"}, 201, uuid.NewString())
	_, second := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "乙"}, 201, uuid.NewString())
	pathA := "/api/v1/people/" + first["id"].(string)
	pathB := "/api/v1/people/" + second["id"].(string)
	f.json(t, "PATCH", pathA, map[string]any{"revision": 1, "is_self": true}, 200, "")
	f.json(t, "PATCH", pathB, map[string]any{"revision": 9, "is_self": true}, 409, "")
	_, kept := f.json(t, "GET", pathA, nil, 200, "")
	if kept["is_self"] != true {
		t.Fatal("conflict removed old self")
	}
	f.json(t, "PATCH", pathB, map[string]any{"revision": 1, "is_self": true}, 200, "")
	_, old := f.json(t, "GET", pathA, nil, 200, "")
	if old["is_self"] != false || old["revision"] != float64(3) {
		t.Fatal("old self not cleared with revision", old)
	}
	_, all := f.json(t, "GET", "/api/v1/people?include_builtin=true", nil, 200, "")
	for _, raw := range all["items"].([]any) {
		p := raw.(map[string]any)
		if p["builtin_key"] != nil {
			f.json(t, "PATCH", "/api/v1/people/"+p["id"].(string), map[string]any{"revision": 1, "is_self": true}, 400, "")
		}
	}
	f.json(t, "PATCH", pathB, map[string]any{"revision": 2, "is_self": false}, 200, "")
}
