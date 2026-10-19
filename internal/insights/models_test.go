package insights

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestListModelsBoundedHTTP(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		want       Error
	}{
		{"sorted", `{"data":[{"id":"z-model"},{"id":"a-model"},{"id":"z-model"}]}`, 200, ""},
		{"empty", `{"data":[]}`, 200, ""},
		{"missing", `{}`, 200, "model_list_invalid"},
		{"null", `{"data":null}`, 200, "model_list_invalid"},
		{"bad-id", `{"data":[{"id":"bad\nmodel"}]}`, 200, "model_list_invalid"},
		{"long-id", `{"data":[{"id":"` + strings.Repeat("x", 201) + `"}]}`, 200, "model_list_invalid"},
		{"html", `<html>upstream secret</html>`, 200, "model_list_invalid"},
		{"too-many", `{"data":[` + strings.TrimSuffix(strings.Repeat(`{"id":"model"},`, 1001), ",") + `]}`, 200, "model_list_too_large"},
		{"oversize", strings.Repeat("x", (1<<20)+1), 200, "model_list_too_large"},
		{"auth", "upstream secret", 401, "model_list_unauthorized"},
		{"forbidden", "upstream secret", 403, "model_list_unauthorized"},
		{"unsupported", "upstream secret", 404, "model_list_unsupported"},
		{"rate-limit", "upstream secret", 429, "model_list_unavailable"},
		{"server-error", "upstream secret", 500, "model_list_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/v1/models" || r.Method != "GET" || r.Header.Get("Authorization") != "Bearer explicit-key" || r.Header.Get("X-Environment-Header") != "" {
					t.Error("incorrect model list request")
				}
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer remote.Close()
			t.Setenv("OPENAI_API_KEY", "environment-key")
			t.Setenv("OPENAI_BASE_URL", "http://127.0.0.1:1")
			t.Setenv("OPENAI_CUSTOM_HEADERS", "X-Environment-Header: bad")
			models, err := ListModels(context.Background(), remote.URL+"/v1/", "explicit-key")
			if tc.want != "" {
				if err != tc.want {
					t.Fatalf("error=%v, want=%v", err, tc.want)
				}
			} else {
				if err != nil || models == nil {
					t.Fatalf("invalid result: %v", err)
				}
				if tc.name == "sorted" && (len(models) != 2 || models[0].ID != "a-model" || models[1].ID != "z-model") {
					t.Fatal(models)
				}
				if tc.name == "empty" && len(models) != 0 {
					t.Fatal(models)
				}
			}
			if calls.Load() != 1 {
				t.Fatal("list request was retried")
			}
		})
	}
}

// @use-case docs/feature/accounts/use-case/manage-server.md
func TestListModelsNoRedirectAndCancellation(t *testing.T) {
	var leaked atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	_, err := ListModels(context.Background(), redirect.URL, "private-key")
	if err != Error("model_list_unavailable") || leaked.Load() != 0 {
		t.Fatal("followed redirect", err)
	}
	started := make(chan struct{})
	finished := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(finished) }))
	defer slow.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := ListModels(ctx, slow.URL, ""); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if err != Error("model_list_timeout") {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("request did not cancel")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("HTTP request remained live")
	}
}
