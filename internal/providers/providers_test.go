package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// @use-case docs/feature/transcription/use-case/transcribe.md
// The real adapters and normalizers run against an HTTP-only fake boundary.

const testKey = "secret-never-return-this-key"

func withServer(t *testing.T, provider string, handler http.HandlerFunc) Adapter {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	if provider == "soniox" {
		a := NewSoniox(testKey).(*soniox)
		a.baseURL, a.client = srv.URL, srv.Client()
		return a
	}
	a := NewAssemblyAI(testKey).(*assemblyAI)
	a.baseURL, a.client = srv.URL, srv.Client()
	return a
}

func assertProviderError(t *testing.T, err error, code string, definitive bool) *Error {
	t.Helper()
	var providerErr *Error
	if !errors.As(err, &providerErr) {
		t.Fatalf("expected provider error %q, got %v", code, err)
	}
	if providerErr.Code != code || providerErr.Definitive != definitive {
		t.Fatalf("error = %+v; want code=%s definitive=%v", providerErr, code, definitive)
	}
	if strings.Contains(err.Error(), testKey) || strings.Contains(err.Error(), "private body") {
		t.Fatalf("error leaks upstream data: %v", err)
	}
	return providerErr
}

func ptr[T any](value T) *T { return &value }

func autoOptions(a Adapter) Options {
	return Options{Provider: a.ID(), Model: a.Models()[0].ID, LanguageMode: "auto", Diarization: true}
}

func fileFor(provider string) Resource {
	if provider == "soniox" {
		return Resource{ID: "file-123", Kind: "file"}
	}
	return Resource{ID: "https://cdn.assemblyai.com/upload/file-123", Kind: "file"}
}

func TestSonioxLifecycle(t *testing.T) {
	var calls []string
	transcript := `{"id":"job-123","text":"Hello, world! Next. 再見。","tokens":[{"text":"Hel","start_ms":0,"end_ms":80,"speaker":"A"},{"text":"lo,","start_ms":80,"end_ms":150,"speaker":"A"},{"text":" world!","start_ms":150,"end_ms":300,"speaker":"A"},{"text":" Next.","start_ms":400,"end_ms":700,"speaker":"A"},{"text":" 再見。","speaker":"B"}]}`
	a := withServer(t, "soniox", func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer "+testKey {
			t.Error("missing bearer authorization")
		}
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/files":
			if r.ContentLength <= 0 {
				t.Error("multipart must have known length")
			}
			reader, err := r.MultipartReader()
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			part, err := reader.NextPart()
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			data, _ := io.ReadAll(part)
			if part.FormName() != "file" || part.FileName() != "meeting.wav" || string(data) != "audio" {
				t.Error("incorrect multipart upload")
			}
			if _, err := reader.NextPart(); err != io.EOF {
				t.Errorf("extra or broken multipart: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			io.WriteString(w, `{"id":"file-123"}`)
		case "POST /v1/transcriptions":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			want := map[string]any{"model": "stt-async-v5", "file_id": "file-123", "language_hints": []any{"en", "zh"}, "language_hints_strict": true, "enable_speaker_diarization": true, "enable_language_identification": true}
			if !reflect.DeepEqual(body, want) {
				t.Errorf("submit body = %#v", body)
			}
			io.WriteString(w, `{"id":"job-123"}`)
		case "GET /v1/transcriptions/job-123":
			io.WriteString(w, `{"status":"completed"}`)
		case "GET /v1/transcriptions/job-123/transcript":
			io.WriteString(w, transcript)
		case "DELETE /v1/transcriptions/job-123", "DELETE /v1/files/file-123":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected call: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	})
	ctx := context.Background()
	file, err := a.Upload(ctx, strings.NewReader("audio"), "meeting.wav", 5)
	if err != nil {
		t.Fatal(err)
	}
	job, err := a.Submit(ctx, file, Options{Provider: "soniox", Model: "stt-async-v5", LanguageMode: "multi", Languages: []string{"en", "zh"}, Diarization: true})
	if err != nil {
		t.Fatal(err)
	}
	state, err := a.Poll(ctx, job)
	if err != nil || state.State != "completed" {
		t.Fatalf("poll = %+v, %v", state, err)
	}
	result, err := a.FetchResult(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	want := []Segment{
		{Text: "Hello, world!", StartMS: ptr[int64](0), EndMS: ptr[int64](300), Speaker: ptr("A")},
		{Text: "Next.", StartMS: ptr[int64](400), EndMS: ptr[int64](700), Speaker: ptr("A")},
		{Text: "再見。", Speaker: ptr("B")},
	}
	if !reflect.DeepEqual(result.Segments, want) || string(result.Raw) != transcript {
		t.Fatalf("result = %+v", result)
	}
	if err := a.DeleteResource(ctx, job); err != nil {
		t.Fatal(err)
	}
	if err := a.DeleteResource(ctx, file); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 6 {
		t.Fatalf("calls = %v", calls)
	}
}

func TestAssemblyLifecycle(t *testing.T) {
	var calls []string
	transcript := `{"id":"job-123","sentences":[{"text":"Hello, world!","start":0,"end":400,"words":[{"text":"Hello,","start":0,"end":150,"speaker":"A"},{"text":"world!","start":200,"end":400,"speaker":"B"}]},{"text":"你好。","words":[]},{"text":"Still here?","start":500,"end":900,"words":[{"text":"Still","start":500,"end":700,"speaker":"B"},{"text":"here?","start":700,"end":900,"speaker":"B"}]}]}`
	a := withServer(t, "assemblyai", func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != testKey {
			t.Error("incorrect authorization")
		}
		switch r.Method + " " + r.URL.Path {
		case "POST /v2/upload":
			data, _ := io.ReadAll(r.Body)
			if string(data) != "audio" || r.Header.Get("Content-Type") != "application/octet-stream" || r.ContentLength != 5 {
				t.Error("incorrect binary upload")
			}
			io.WriteString(w, `{"upload_url":"https://cdn.assemblyai.com/upload/file-123"}`)
		case "POST /v2/transcript":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			want := map[string]any{"audio_url": "https://cdn.assemblyai.com/upload/file-123", "speech_models": []any{"universal-3-5-pro"}, "speaker_labels": true, "punctuate": true, "format_text": true, "language_codes": []any{"zh", "ja", "fr"}}
			if !reflect.DeepEqual(body, want) {
				t.Errorf("submit body = %#v", body)
			}
			io.WriteString(w, `{"id":"job-123"}`)
		case "GET /v2/transcript/job-123":
			io.WriteString(w, `{"status":"completed"}`)
		case "GET /v2/transcript/job-123/sentences":
			io.WriteString(w, transcript)
		case "DELETE /v2/transcript/job-123":
			io.WriteString(w, `{"id":"job-123","is_deleted":true}`)
		default:
			t.Errorf("unexpected call: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	})
	ctx := context.Background()
	file, err := a.Upload(ctx, strings.NewReader("audio"), "meeting.wav", 5)
	if err != nil {
		t.Fatal(err)
	}
	job, err := a.Submit(ctx, file, Options{Provider: "assemblyai", Model: "universal-3-5-pro", LanguageMode: "multi", Languages: []string{"zh", "ja", "fr"}, Diarization: true})
	if err != nil {
		t.Fatal(err)
	}
	state, err := a.Poll(ctx, job)
	if err != nil || state.State != "completed" {
		t.Fatalf("poll = %+v, %v", state, err)
	}
	result, err := a.FetchResult(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	want := []Segment{
		{Text: "Hello,", StartMS: ptr[int64](0), EndMS: ptr[int64](150), Speaker: ptr("A")},
		{Text: "world!", StartMS: ptr[int64](200), EndMS: ptr[int64](400), Speaker: ptr("B")},
		{Text: "你好。"},
		{Text: "Still here?", StartMS: ptr[int64](500), EndMS: ptr[int64](900), Speaker: ptr("B")},
	}
	if !reflect.DeepEqual(result.Segments, want) || string(result.Raw) != transcript {
		t.Fatalf("result = %+v", result)
	}
	if err := a.DeleteResource(ctx, job); err != nil {
		t.Fatal(err)
	}
	assertProviderError(t, a.DeleteResource(ctx, file), "unsupported", true)
	if len(calls) != 5 {
		t.Fatalf("calls = %v", calls)
	}
}

func TestCreationFailuresAreClassifiedWithoutRetry(t *testing.T) {
	cases := []struct {
		status     int
		body, code string
		definitive bool
	}{
		{400, "private body " + testKey, "invalid", true},
		{401, "private body " + testKey, "auth", true},
		{403, "private body " + testKey, "auth", true},
		{404, "private body " + testKey, "not_found", true},
		{413, "private body " + testKey, "invalid", true},
		{422, "private body " + testKey, "invalid", true},
		{429, "private body " + testKey, "rate_limited", true},
		{408, "private body " + testKey, "uncertain", false},
		{409, "private body " + testKey, "uncertain", false},
		{500, "private body " + testKey, "uncertain", false},
		{503, "private body " + testKey, "uncertain", false},
		{200, "broken json " + testKey, "uncertain", false},
		{200, `{}`, "uncertain", false},
		{200, `{"id":"../bad","upload_url":"file:///bad"}`, "uncertain", false},
	}
	for _, provider := range []string{"soniox", "assemblyai"} {
		for _, operation := range []string{"upload", "submit"} {
			for _, tc := range cases {
				t.Run(fmt.Sprintf("%s/%s/%d/%s", provider, operation, tc.status, tc.body[:min(8, len(tc.body))]), func(t *testing.T) {
					var calls atomic.Int32
					a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
						calls.Add(1)
						io.Copy(io.Discard, r.Body)
						w.Header().Set("Retry-After", "17")
						w.WriteHeader(tc.status)
						io.WriteString(w, tc.body)
					})
					var err error
					if operation == "upload" {
						_, err = a.Upload(context.Background(), strings.NewReader("audio"), "meeting.wav", 5)
					} else {
						_, err = a.Submit(context.Background(), fileFor(provider), autoOptions(a))
					}
					pe := assertProviderError(t, err, tc.code, tc.definitive)
					if tc.status == 429 && pe.RetryAfterSeconds != 17 {
						t.Fatalf("Retry-After = %d", pe.RetryAfterSeconds)
					}
					if calls.Load() != 1 {
						t.Fatalf("creation sent %d times", calls.Load())
					}
				})
			}
		}
	}
}

func TestLostCreationResponsesRemainUncertain(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		for _, operation := range []string{"upload", "submit"} {
			t.Run(provider+"/"+operation, func(t *testing.T) {
				var calls atomic.Int32
				a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					io.Copy(io.Discard, r.Body)
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					conn.Close()
				})
				var err error
				if operation == "upload" {
					_, err = a.Upload(context.Background(), strings.NewReader("audio"), "meeting.wav", 5)
				} else {
					_, err = a.Submit(context.Background(), fileFor(provider), autoOptions(a))
				}
				assertProviderError(t, err, "uncertain", false)
				if calls.Load() != 1 {
					t.Fatalf("creation sent %d times", calls.Load())
				}
			})
		}
	}
}

func TestCreationCancellationAfterAcceptance(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		for _, operation := range []string{"upload", "submit"} {
			t.Run(provider+"/"+operation, func(t *testing.T) {
				accepted := make(chan struct{})
				a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
					io.Copy(io.Discard, r.Body)
					close(accepted)
					select {
					case <-r.Context().Done():
					case <-time.After(2 * time.Second):
						t.Error("server did not observe cancellation")
					}
				})
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				done := make(chan error, 1)
				go func() {
					var err error
					if operation == "upload" {
						_, err = a.Upload(ctx, strings.NewReader("audio"), "meeting.wav", 5)
					} else {
						_, err = a.Submit(ctx, fileFor(provider), autoOptions(a))
					}
					done <- err
				}()
				select {
				case <-accepted:
				case <-time.After(2 * time.Second):
					t.Fatal("request never reached HTTP boundary")
				}
				cancel()
				select {
				case err := <-done:
					assertProviderError(t, err, "uncertain", false)
				case <-time.After(2 * time.Second):
					t.Fatal("canceled creation did not return")
				}
			})
		}
	}
}

func TestRedirectNeverCreatesSecondResourceOrLeaksKey(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		for _, operation := range []string{"upload", "submit"} {
			for _, status := range []int{302, 307, 308} {
				t.Run(fmt.Sprintf("%s/%s/%d", provider, operation, status), func(t *testing.T) {
					var targetCalls, initialCalls atomic.Int32
					target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls.Add(1) }))
					defer target.Close()
					a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
						initialCalls.Add(1)
						io.Copy(io.Discard, r.Body)
						http.Redirect(w, r, target.URL, status)
					})
					var err error
					if operation == "upload" {
						_, err = a.Upload(context.Background(), strings.NewReader("audio"), "meeting.wav", 5)
					} else {
						_, err = a.Submit(context.Background(), fileFor(provider), autoOptions(a))
					}
					assertProviderError(t, err, "uncertain", false)
					if targetCalls.Load() != 0 || initialCalls.Load() != 1 {
						t.Fatal("redirect followed or creation retried")
					}
				})
			}
		}
	}
}

type gatedAudio struct {
	gate    <-chan struct{}
	maxRead atomic.Int64
}

func (a *gatedAudio) Read(p []byte) (int, error) {
	select {
	case <-a.gate:
	case <-time.After(2 * time.Second):
		return 0, errors.New("audio was buffered before HTTP headers arrived")
	}
	for old := a.maxRead.Load(); int64(len(p)) > old; old = a.maxRead.Load() {
		if a.maxRead.CompareAndSwap(old, int64(len(p))) {
			break
		}
	}
	for i := range p {
		p[i] = 'a'
	}
	return len(p), nil
}

func TestUploadsStreamWithBoundedReads(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		t.Run(provider, func(t *testing.T) {
			const size = 16 << 20
			gate := make(chan struct{})
			audio := &gatedAudio{gate: gate}
			a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
				close(gate)
				var reader io.Reader = r.Body
				if provider == "soniox" {
					mr, err := r.MultipartReader()
					if err != nil {
						t.Error(err)
						return
					}
					part, err := mr.NextPart()
					if err != nil {
						t.Error(err)
						return
					}
					reader = part
				}
				n, err := io.Copy(io.Discard, reader)
				if err != nil || n != size {
					t.Errorf("received %d bytes, err=%v", n, err)
				}
				if provider == "soniox" {
					io.WriteString(w, `{"id":"file-123"}`)
				} else {
					io.WriteString(w, `{"upload_url":"https://cdn.assemblyai.com/upload/file-123"}`)
				}
			})
			if _, err := a.Upload(context.Background(), audio, "large.wav", size); err != nil {
				t.Fatal(err)
			}
			if n := audio.maxRead.Load(); n == 0 || n > 256<<10 {
				t.Fatalf("unexpected source buffer size %d", n)
			}
		})
	}
}
