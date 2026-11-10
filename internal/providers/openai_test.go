package providers

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestOpenAIMultipartAndDiarizedResult(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "wrong-key")
	t.Setenv("OPENAI_BASE_URL", "http://unused.invalid")
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "POST" || r.URL.Path != "/v1/audio/transcriptions" || r.Header.Get("Authorization") != "Bearer "+testKey {
			t.Errorf("wrong explicit request: %s %s", r.Method, r.URL.Path)
		}
		if err := r.ParseMultipartForm(1024); err != nil {
			t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		for key, want := range map[string]string{"model": "gpt-4o-transcribe-diarize", "response_format": "diarized_json", "chunking_strategy": "auto", "language": "zh"} {
			if r.FormValue(key) != want {
				t.Errorf("%s=%s", key, r.FormValue(key))
			}
		}
		f, h, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
			return
		}
		defer f.Close()
		data, _ := io.ReadAll(f)
		if string(data) != "audio" || h.Filename != "meeting.wav" {
			t.Error("invalid audio")
		}
		io.WriteString(w, `{"segments":[{"text":"你好","speaker":"A","start":0.125,"end":1.5},{"text":"hi","speaker":"B","start":1.5,"end":2}]}`)
	}))
	defer srv.Close()
	a := NewOpenAI(srv.URL+"/v1", testKey)
	o := autoOptions(a)
	o.LanguageMode = "single"
	o.Languages = []string{"zh"}
	result, err := a.Transcribe(context.Background(), strings.NewReader("audio"), "meeting.wav", 5, o)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Segments) != 2 || *result.Segments[0].StartMS != 125 || *result.Segments[0].EndMS != 1500 || *result.Segments[1].Speaker != "B" || len(result.Raw) == 0 || calls.Load() != 1 {
		t.Fatalf("result=%+v calls=%d", result, calls.Load())
	}
	if NewOpenAI("", "").(*openai).baseURL != DefaultOpenAIBaseURL {
		t.Fatal("default URL")
	}
	models := a.Models()
	models[0].Languages[0] = "wrong"
	if a.Models()[0].Languages[0] == "wrong" {
		t.Fatal("mutable catalog")
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestOpenAIRejectsInvalidFilesOptionsAndResults(t *testing.T) {
	var calls atomic.Int32
	response := `{"segments":[]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		io.Copy(io.Discard, r.Body)
		io.WriteString(w, response)
	}))
	defer srv.Close()
	a := NewOpenAI(srv.URL, testKey)
	o := autoOptions(a)
	for _, c := range []struct {
		name string
		size int64
	}{{"a.wav", 0}, {"a.wav", OpenAIMaxFileBytes + 1}, {"a.ogg", 5}, {"a\n.wav", 5}} {
		if _, err := a.Transcribe(context.Background(), strings.NewReader("audio"), c.name, c.size, o); err == nil {
			t.Fatal("invalid file accepted")
		}
	}
	bad := o
	bad.LanguageMode = "multi"
	bad.Languages = []string{"en", "zh"}
	if _, err := a.Transcribe(context.Background(), strings.NewReader("audio"), "a.wav", 5, bad); err == nil {
		t.Fatal("multi accepted")
	}
	if calls.Load() != 0 {
		t.Fatal("invalid input reached network")
	}
	for _, value := range []string{`{`, `{}`, `{"segments":[]}`, `{"segments":[{"text":"x","speaker":"A","end":1}]}`, `{"segments":[{"text":1,"speaker":"A","start":0,"end":1}]}`, `{"segments":[{"text":"x","speaker":"","start":0,"end":1}]}`, `{"segments":[{"text":"x","speaker":"A","start":2,"end":1}]}`, `{"segments":[{"text":"x","speaker":"A","start":-1,"end":1}]}`, `{"segments":[{"text":"x","speaker":"A","start":0,"end":1e20}]}`} {
		response = value
		_, err := a.Transcribe(context.Background(), strings.NewReader("audio"), "a.wav", 5, o)
		assertProviderError(t, err, "direct_invalid_result", true)
	}
}

// @use-case docs/feature/transcription/use-case/recover-task.md
func TestOpenAINeverRetriesRedirectsOrLeaksErrors(t *testing.T) {
	for _, status := range []int{307, 308, 401, 429, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Location", "/leak")
				w.WriteHeader(status)
				io.WriteString(w, testKey+" private body")
			}))
			defer srv.Close()
			a := NewOpenAI(srv.URL, testKey)
			_, err := a.Transcribe(context.Background(), strings.NewReader("audio"), "a.wav", 5, autoOptions(a))
			if err == nil || !strings.Contains(err.Error(), "direct_") || strings.Contains(err.Error(), testKey) || calls.Load() != 1 {
				t.Fatalf("err=%v calls=%d", err, calls.Load())
			}
		})
	}
}

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestOpenAICancellationAndReaderOwnership(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); <-r.Context().Done() }))
	defer srv.Close()
	a := NewOpenAI(srv.URL, testKey)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	source := &ownedAudio{Reader: strings.NewReader("audio")}
	_, err := a.Transcribe(ctx, source, "a.wav", 5, autoOptions(a))
	if err == nil || source.closed {
		t.Fatalf("err=%v closed=%v", err, source.closed)
	}
}

type ownedAudio struct {
	io.Reader
	closed bool
}

func (a *ownedAudio) Close() error { a.closed = true; return nil }
