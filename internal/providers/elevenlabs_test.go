package providers

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func elevenLabsWithServer(t *testing.T, handler http.HandlerFunc) FileSubmitAdapter {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("xi-api-key") != testKey || r.Header.Get("Authorization") != "" {
			t.Error("wrong authentication header")
		}
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	a := NewElevenLabs(testKey).(*elevenLabs)
	a.baseURL, a.client = srv.URL, srv.Client()
	return a
}

// @use-case docs/feature/transcription/use-case/transcribe.md#elevenlabs-scribe
func TestElevenLabsLifecycle(t *testing.T) {
	for _, language := range []string{"", "zh"} {
		t.Run("language="+language, func(t *testing.T) {
			var submits, reads, deletes atomic.Int32
			const transcript = `{"transcription_id":"stt_123","text":"Hello, world!  Next.你好。再見。","words":[
				{"type":"word","text":"Hello,","start":0.125,"end":0.25,"speaker_id":"speaker_0"},
				{"type":"spacing","text":" ","start":null,"end":null,"speaker_id":null},
				{"type":"word","text":"world!","start":0.26,"end":0.8906,"speaker_id":"speaker_0"},
				{"type":"spacing","text":"  "},
				{"type":"word","text":"Next.","start":0.9,"end":1.1,"speaker_id":"speaker_0"},
				{"type":"word","text":"你","start":1.2,"end":1.3,"speaker_id":"speaker_1"},
				{"type":"word","text":"好。","start":null,"end":1.5,"speaker_id":"speaker_1"},
				{"type":"word","text":"再見。","start":1.6,"end":2.0,"speaker_id":"speaker_1"}]}`
			a := elevenLabsWithServer(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.Method + " " + r.URL.Path {
				case "POST /v1/speech-to-text":
					submits.Add(1)
					if r.ContentLength <= 5 {
						t.Error("multipart request has no declared framing size")
					}
					if err := r.ParseMultipartForm(1024); err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					defer r.MultipartForm.RemoveAll()
					want := map[string][]string{
						"model_id": {"scribe_v2"}, "diarize": {"true"}, "timestamps_granularity": {"word"},
						"tag_audio_events": {"false"}, "webhook": {"false"},
					}
					if language != "" {
						want["language_code"] = []string{language}
					}
					if !reflect.DeepEqual(r.MultipartForm.Value, want) {
						t.Errorf("form fields = %v, want %v", r.MultipartForm.Value, want)
					}
					f, h, err := r.FormFile("file")
					if err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					defer f.Close()
					data, err := io.ReadAll(f)
					if err != nil || string(data) != "audio" || h.Filename != "meeting.wav" {
						t.Errorf("multipart file %q = %q, err=%v", h.Filename, data, err)
					}
					io.WriteString(w, `{"transcription_id":"stt_123","text":"Do not publish from POST."}`)
				case "GET /v1/speech-to-text/transcripts/stt_123":
					reads.Add(1)
					io.WriteString(w, transcript)
				case "DELETE /v1/speech-to-text/transcripts/stt_123":
					deletes.Add(1)
					io.WriteString(w, `{"status":"ok"}`)
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			})
			ctx := context.Background()
			options := autoOptions(a)
			if language != "" {
				options.LanguageMode, options.Languages = "single", []string{language}
			}
			audio := &ownedAudio{Reader: strings.NewReader("audio")}
			resource, err := a.SubmitFile(ctx, audio, "meeting.wav", 5, options)
			if err != nil || resource != (Resource{ID: "stt_123", Kind: "transcription"}) || audio.closed {
				t.Fatalf("resource=%+v err=%v audio closed=%v", resource, err, audio.closed)
			}
			result, err := a.FetchResult(ctx, resource)
			want := []Segment{
				{Text: "Hello, world!  ", StartMS: ptr[int64](125), EndMS: ptr[int64](891), Speaker: ptr("speaker_0")},
				{Text: "Next.", StartMS: ptr[int64](900), EndMS: ptr[int64](1100), Speaker: ptr("speaker_0")},
				{Text: "你好。", Speaker: ptr("speaker_1")},
				{Text: "再見。", StartMS: ptr[int64](1600), EndMS: ptr[int64](2000), Speaker: ptr("speaker_1")},
			}
			if err != nil || !reflect.DeepEqual(result.Segments, want) || string(result.Raw) != transcript {
				t.Fatalf("segments=%#v, want=%#v, err=%v", result.Segments, want, err)
			}
			if err := a.DeleteResource(ctx, resource); err != nil {
				t.Fatal(err)
			}
			if submits.Load() != 1 || reads.Load() != 1 || deletes.Load() != 1 {
				t.Fatalf("request counts submit=%d, get=%d, delete=%d", submits.Load(), reads.Load(), deletes.Load())
			}
		})
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md#choose-options
func TestElevenLabsRejectsInvalidInputsBeforeHTTP(t *testing.T) {
	var calls atomic.Int32
	a := elevenLabsWithServer(t, func(w http.ResponseWriter, _ *http.Request) { calls.Add(1) })
	ctx := context.Background()
	valid := autoOptions(a)
	models := a.Models()
	if a.ID() != "elevenlabs" || len(models) != 1 || models[0].ID != "scribe_v2" ||
		models[0].MaxDurationMS != (10*time.Hour).Milliseconds() || models[0].MaxFileBytes != 4_999_999_999 ||
		!models[0].Diarization || !models[0].Timestamps {
		t.Fatalf("models = %+v", models)
	}
	if NewElevenLabs("").(*elevenLabs).baseURL != "https://api.elevenlabs.io" {
		t.Fatal("incorrect production endpoint")
	}
	for _, size := range []int64{0, -1, 5_000_000_000} {
		_, err := a.SubmitFile(ctx, strings.NewReader("audio"), "a.wav", size, valid)
		assertProviderError(t, err, "invalid", true)
	}
	_, err := a.SubmitFile(ctx, nil, "a.wav", 5, valid)
	assertProviderError(t, err, "invalid", true)
	_, err = a.SubmitFile(ctx, strings.NewReader("audio"), "invalid\r\na.wav", 5, valid)
	assertProviderError(t, err, "invalid", true)
	for _, tc := range []struct {
		options Options
		code    string
	}{
		{Options{Provider: "soniox", Model: "scribe_v2", LanguageMode: "auto"}, "invalid"},
		{Options{Provider: "elevenlabs", Model: "scribe_v3", LanguageMode: "auto"}, "unsupported"},
		{Options{Provider: "elevenlabs", Model: "scribe_v2", LanguageMode: "multi", Languages: []string{"en", "zh"}}, "unsupported"},
		{Options{Provider: "elevenlabs", Model: "scribe_v2", LanguageMode: "auto", Languages: []string{"en"}}, "invalid"},
		{Options{Provider: "elevenlabs", Model: "scribe_v2", LanguageMode: "single"}, "invalid"},
		{Options{Provider: "elevenlabs", Model: "scribe_v2", LanguageMode: "single", Languages: []string{"unknown"}}, "unsupported"},
	} {
		_, err := a.SubmitFile(ctx, strings.NewReader("audio"), "a.wav", 5, tc.options)
		assertProviderError(t, err, tc.code, true)
	}
	for _, r := range []Resource{{ID: "../leak", Kind: "transcription"}, {ID: "stt_123", Kind: "file"}} {
		_, err := a.FetchResult(ctx, r)
		assertProviderError(t, err, "invalid", true)
		assertProviderError(t, a.DeleteResource(ctx, r), "invalid", true)
	}
	if calls.Load() != 0 {
		t.Fatal("invalid inputs reached the network")
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md#submit
func TestElevenLabsStreamsAudioBeforeReaderEOF(t *testing.T) {
	const blockSize = 64 << 10
	firstBlock := strings.Repeat("a", blockSize)
	firstBlockReceived := make(chan struct{})
	a := elevenLabsWithServer(t, func(w http.ResponseWriter, r *http.Request) {
		parts, err := r.MultipartReader()
		if err != nil {
			t.Error(err)
			return
		}
		for {
			part, err := parts.NextPart()
			if err != nil {
				t.Error(err)
				return
			}
			if part.FormName() != "file" {
				continue
			}
			content := make([]byte, blockSize)
			_, err = io.ReadFull(part, content)
			close(firstBlockReceived)
			if err != nil || string(content) != firstBlock {
				t.Errorf("unexpected first block: %v", err)
				return
			}
			rest, err := io.ReadAll(part)
			if err != nil || string(rest) != "tail" {
				t.Errorf("last bytes = %q, err=%v", rest, err)
				return
			}
			io.WriteString(w, `{"transcription_id":"stt_streamed"}`)
			return
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	reader, writer := io.Pipe()
	defer reader.Close()
	go func() {
		defer writer.Close()
		if _, err := io.WriteString(writer, firstBlock); err != nil {
			return
		}
		select {
		case <-firstBlockReceived:
			io.WriteString(writer, "tail")
		case <-ctx.Done():
			writer.CloseWithError(ctx.Err())
		}
	}()
	resource, err := a.SubmitFile(ctx, reader, "a.wav", blockSize+4, autoOptions(a))
	if err != nil || resource.ID != "stt_streamed" {
		t.Fatalf("resource=%+v err=%v", resource, err)
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestElevenLabsCreateFailuresDoNotReplayOrLeak(t *testing.T) {
	var redirectCalls atomic.Int32
	redirect := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirectCalls.Add(1) }))
	defer redirect.Close()
	for _, tc := range []struct {
		name, body, code, reason string
		status                   int
		definitive               bool
	}{
		{"missing ID", `{"text":"exists"}`, "uncertain", "invalid_resource", 200, false},
		{"null ID", `{"transcription_id":null}`, "uncertain", "invalid_resource", 200, false},
		{"invalid ID", `{"transcription_id":"../other"}`, "uncertain", "invalid_resource", 200, false},
		{"malformed JSON", `{"transcription_id":`, "uncertain", "invalid_json", 200, false},
		{"302 redirect", testKey, "uncertain", "http_status", 302, false},
		{"307 redirect", testKey, "uncertain", "http_status", 307, false},
		{"308 redirect", testKey, "uncertain", "http_status", 308, false},
		{"auth", testKey, "auth", "http_status", 401, true},
		{"rate limit", testKey, "rate_limited", "http_status", 429, true},
		{"upstream failure", testKey, "uncertain", "http_status", 503, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			a := elevenLabsWithServer(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				io.Copy(io.Discard, r.Body)
				w.Header().Set("Location", redirect.URL)
				w.Header().Set("Retry-After", "12")
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			})
			resource, err := a.SubmitFile(context.Background(), strings.NewReader("audio"), "a.wav", 5, autoOptions(a))
			pe := assertProviderError(t, err, tc.code, tc.definitive)
			if pe.Reason != tc.reason || resource != (Resource{}) || calls.Load() != 1 || redirectCalls.Load() != 0 {
				t.Fatalf("error=%+v resource=%+v calls=%d redirects=%d", pe.Diagnostic(), resource, calls.Load(), redirectCalls.Load())
			}
			if tc.reason == "http_status" && (pe.HTTPStatus != tc.status || pe.RetryAfterSeconds != 12) {
				t.Fatalf("status=%d retry after=%d", pe.HTTPStatus, pe.RetryAfterSeconds)
			}
		})
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md#elevenlabs-scribe
func TestElevenLabsBoundsCreateAndFetchResponses(t *testing.T) {
	a := elevenLabsWithServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		chunk := strings.Repeat(" ", 64<<10)
		for sent := 0; sent <= maxResponseBytes; sent += len(chunk) {
			if _, err := io.WriteString(w, chunk); err != nil {
				return
			}
		}
	})
	ctx := context.Background()
	_, err := a.SubmitFile(ctx, strings.NewReader("audio"), "a.wav", 5, autoOptions(a))
	createErr := assertProviderError(t, err, "uncertain", false)
	_, err = a.FetchResult(ctx, Resource{ID: "stt_123", Kind: "transcription"})
	fetchErr := assertProviderError(t, err, "transient", false)
	for _, pe := range []*Error{createErr, fetchErr} {
		if pe.Reason != "response_too_large" || pe.HTTPStatus != http.StatusOK {
			t.Fatalf("diagnostic=%+v", pe.Diagnostic())
		}
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md#complete
func TestElevenLabsFetchRetainsAvailableText(t *testing.T) {
	for _, tc := range []struct {
		body string
		want []Segment
	}{
		{`{"text":" Text-only fallback, exactly. "}`, []Segment{{Text: " Text-only fallback, exactly. "}}},
		{`{"words":[{"text":"No labels.","start":0,"end":1.26,"speaker_id":null}]}`, []Segment{{Text: "No labels.", StartMS: ptr[int64](0), EndMS: ptr[int64](1260)}}},
		{`{"words":[{"text":"Missing end","start":0,"speaker_id":"a"},{"type":"spacing","text":"\n"},{"text":"Invalid range.","start":3,"end":2,"speaker_id":"a"}]}`, []Segment{{Text: "Missing end\n", Speaker: ptr("a")}, {Text: "Invalid range.", Speaker: ptr("a")}}},
		{`{"text":"","words":[]}`, []Segment{}},
		{`{"transcription_id":"different","text":"Wrong transcript."}`, nil},
		{`{"transcription_id":"stt_123"}`, nil},
	} {
		t.Run(tc.body, func(t *testing.T) {
			a := elevenLabsWithServer(t, func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, tc.body) })
			result, err := a.FetchResult(context.Background(), Resource{ID: "stt_123", Kind: "transcription"})
			if tc.want == nil {
				assertProviderError(t, err, "transient", false)
			} else if err != nil || !reflect.DeepEqual(result.Segments, tc.want) || string(result.Raw) != tc.body {
				t.Fatalf("segments=%#v, want=%#v, err=%v", result.Segments, tc.want, err)
			}
		})
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md#elevenlabs-scribe
func TestElevenLabsDeleteConfirmsRemoteAbsence(t *testing.T) {
	var calls atomic.Int32
	a := elevenLabsWithServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/v1/speech-to-text/transcripts/stt_123" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		status := [...]int{http.StatusBadGateway, http.StatusAccepted, http.StatusNotFound}
		w.WriteHeader(status[min(int(calls.Add(1))-1, len(status)-1)])
		io.WriteString(w, "private body "+testKey)
	})
	r := Resource{ID: "stt_123", Kind: "transcription"}
	ctx := context.Background()
	for _, want := range []int{http.StatusBadGateway, http.StatusAccepted} {
		pe := assertProviderError(t, a.DeleteResource(ctx, r), "transient", false)
		if pe.HTTPStatus != want || pe.Reason != "http_status" {
			t.Fatalf("diagnostic=%+v", pe.Diagnostic())
		}
	}
	if err := a.DeleteResource(ctx, r); err != nil || calls.Load() != 3 {
		t.Fatalf("err=%v calls=%d", err, calls.Load())
	}
}
