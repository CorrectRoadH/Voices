package insights

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestGenerateSDKBoundary(t *testing.T) {
	for _, k := range []string{"OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"} {
		t.Setenv(k, "SECRET_ENV")
	}
	t.Setenv("OPENAI_BASE_URL", "https://invalid.example")
	t.Setenv("OPENAI_CUSTOM_HEADERS", "Authorization: Bearer SECRET_ENV\nX-Secret: SECRET_ENV")
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path: %s", r.URL.Path)
		}
		for _, k := range []string{"Authorization", "OpenAI-Organization", "OpenAI-Project", "X-Secret"} {
			if r.Header.Get(k) != "" {
				t.Errorf("inherited %s", k)
			}
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "local" || body["max_completion_tokens"] != float64(4096) {
			t.Errorf("wrong model or limit")
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": `{"summary":"摘要","chapters":[{"segment_id":"a","title":"开场"},{"segment_id":"b","title":"下一章"}]}`}}}})
	}))
	defer server.Close()
	start := int64(1000)
	result, err := Generate(context.Background(), server.URL+"/v1", "", "local", []Segment{{ID: "a", Text: "hello"}, {ID: "b", Text: "next", StartMS: &start}})
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || result.Chapters[0].StartMS != nil || *result.Chapters[1].StartMS != 1000 {
		t.Fatal(result, calls.Load())
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestLLMFailuresNeverRetryOrLeak(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		code   Error
	}{{"server", 500, `SECRET`, "llm_unavailable"}, {"rejected", 400, `SECRET`, "llm_rejected"}, {"large", 200, strings.Repeat("x", (1<<20)+1), InvalidResponse}, {"redirect", 302, "", "llm_unavailable"}, {"invalid", 200, `{"choices":[{"finish_reason":"stop","message":{"content":"{\"summary\":\"ok\",\"chapters\":[{\"segment_id\":\"unknown\",\"title\":\"bad\"}]}"}}]}`, InvalidResponse}, {"truncated", 200, `{"choices":[{"finish_reason":"length","message":{"content":"SECRET"}}]}`, InvalidResponse}} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Location", "/redirected")
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer server.Close()
			_, err := Generate(context.Background(), server.URL, "key", "model", []Segment{{ID: "a", Text: "test"}})
			if err != tc.code {
				t.Fatalf("%v want %v", err, tc.code)
			}
			if calls.Load() != 1 {
				t.Fatal("retried", calls.Load())
			}
		})
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func TestOutputAnchorsAndCancellation(t *testing.T) {
	for _, content := range []string{`{"summary":"s","chapters":[]}`, `{"summary":"s","chapters":[{"segment_id":"b","title":"second"}]}`, `{"summary":"s","chapters":[{"segment_id":"a","title":"first"},{"segment_id":"a","title":"again"}]}`, `{"summary":"s","chapters":[{"segment_id":"a","title":"first","start_ms":0}]}`, `{"summary":"s","chapters":[{"segment_id":"a","title":"first"}]} {}`} {
		if _, err := Validate(content, []Segment{{ID: "a"}, {ID: "b"}}); err != InvalidResponse {
			t.Fatal(content, err)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); <-r.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := Generate(ctx, server.URL, "", "model", []Segment{{ID: "a"}})
	if err != Error("interrupted") {
		t.Fatal(err)
	}
}
