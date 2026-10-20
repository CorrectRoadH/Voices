package insights

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// @use-case docs/feature/insights/use-case/generate-insights.md
func Test生成请求隔离SDK环境并使用真实片段时间(t *testing.T) {
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
		messages := body["messages"].([]any)
		var sent []Segment
		if err := json.Unmarshal([]byte(messages[1].(map[string]any)["content"].(string)), &sent); err != nil {
			t.Fatal(err)
		}
		if len(sent) != 2 || sent[0].ID != "s1" || sent[1].ID != "s2" || sent[1].Text != "next" {
			t.Errorf("unexpected model input: %+v", sent)
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": `{"summary":"摘要","chapters":[{"segment_id":"s1","title":"开场"},{"segment_id":"s2","title":"下一章"}]}`}}}})
	}))
	defer server.Close()
	start := int64(1000)
	result, err := Generate(context.Background(), server.URL+"/v1", "", "local", []Segment{{ID: "a", Text: "hello"}, {ID: "b", Text: "next", StartMS: &start}})
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || result.Chapters[0].SegmentID != "a" || result.Chapters[1].SegmentID != "b" || result.Chapters[0].StartMS != nil || *result.Chapters[1].StartMS != 1000 {
		t.Fatal(result, calls.Load())
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func Test模型失败不重试且不泄漏内容(t *testing.T) {
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
			if !errors.Is(err, tc.code) {
				t.Fatalf("%v want %v", err, tc.code)
			}
			if calls.Load() != 1 {
				t.Fatal("retried", calls.Load())
			}
		})
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func Test生成失败原因保持错误码且不泄漏内容(t *testing.T) {
	valid := `{"summary":"s","chapters":[{"segment_id":"s1","title":"first"}]}`
	for _, tc := range []struct{ name, finish, refusal, content, reason string }{
		{"输出截断", "length", "", "SECRET", "output_token_limit"},
		{"模型拒答", "stop", "SECRET", "", "model_refusal"},
		{"内容过滤", "content_filter", "", "SECRET", "model_refusal"},
		{"未知完成原因", "SECRET", "", valid, "unexpected_finish_reason"},
		{"结构错误", "stop", "", `{"SECRET":true}`, "json_schema"},
		{"不接受模型生成时间", "stop", "", `{"summary":"s","chapters":[{"segment_id":"s1","title":"first","start_ms":0}]}`, "json_schema"},
		{"多余内容", "stop", "", valid + " SECRET", "trailing_content"},
		{"空摘要", "stop", "", `{"summary":"","chapters":[]}`, "summary_length"},
		{"空目录", "stop", "", `{"summary":"s","chapters":[]}`, "chapter_count"},
		{"未知片段", "stop", "", `{"summary":"s","chapters":[{"segment_id":"SECRET","title":"first"}]}`, "unknown_segment"},
		{"首章锚点错误", "stop", "", `{"summary":"s","chapters":[{"segment_id":"s2","title":"first"}]}`, "first_chapter_anchor"},
		{"章节重复", "stop", "", `{"summary":"s","chapters":[{"segment_id":"s1","title":"first"},{"segment_id":"s1","title":"again"}]}`, "chapter_order"},
		{"空标题", "stop", "", `{"summary":"s","chapters":[{"segment_id":"s1","title":""}]}`, "chapter_title_length"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": tc.finish, "message": map[string]any{"content": tc.content, "refusal": tc.refusal}}}})
			}))
			defer server.Close()
			_, err := Generate(context.Background(), server.URL, "", "model", []Segment{{ID: "a"}, {ID: "b"}})
			var code Error
			if !errors.Is(err, InvalidResponse) || !errors.As(err, &code) || code != InvalidResponse {
				t.Fatalf("lost public error code: %v", err)
			}
			if FailureReason(err) != tc.reason || err.Error() != string(InvalidResponse) || calls.Load() != 1 {
				t.Fatalf("diagnostic=%q error=%q calls=%d", FailureReason(err), err, calls.Load())
			}
		})
	}
	if FailureReason(errors.New("SECRET")) != "unspecified" {
		t.Fatal("untrusted error exposed")
	}
}

// @use-case docs/feature/insights/use-case/generate-insights.md
func Test取消生成会终止请求(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); <-r.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := Generate(ctx, server.URL, "", "model", []Segment{{ID: "a"}})
	if err != Error("interrupted") {
		t.Fatal(err)
	}
}
