package updates

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func manifest() Manifest {
	v, link := "1.10.0", "https://github.com/CorrectRoadH/Voices/releases/tag/v1.10.0"
	date := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return Manifest{SchemaVersion: 1, LatestVersion: &v, ReleaseURL: &link, ReleasedAt: &date, ReleaseNotes: "notes", Announcements: []Announcement{{ID: "notice", Title: "Notice", Body: "text", Severity: "info", PublishedAt: date}}}
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestVersionComparison(t *testing.T) {
	for _, tt := range []struct {
		latest, current string
		want            bool
	}{{"1.10.0", "1.9.9", true}, {"v2.0.0", "1.99.0", true}, {"1.0.0", "2.0.0", false}, {"1.0.0", "1.0.0", false}, {"1.0.0", "dev", false}, {"1.1.0-beta", "1.0.0", false}, {"01.0.0", "0.0.0", false}, {"4294967296.0.0", "1.0.0", false}} {
		if got := Newer(tt.latest, tt.current); got != tt.want {
			t.Fatalf("%+v got %v", tt, got)
		}
	}
	for _, raw := range []string{"http://example.test", "https://user:pass@example.test", "https://example.test/?secret=x", "https://example.test/#x", "https:///"} {
		if ValidEndpoint(raw) {
			t.Fatal("accepted", raw)
		}
	}
	if !ValidEndpoint("") || !ValidEndpoint("https://updates.example.test/") {
		t.Fatal("valid endpoint rejected")
	}
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestCacheTransitions(t *testing.T) {
	var mode atomic.Int32
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.RawQuery != "" || r.Header.Get("Cookie") != "" {
			t.Error("client context leaked")
		}
		m := manifest()
		switch mode.Load() {
		case 1:
			http.Error(w, "offline", 503)
			return
		case 2:
			m.LatestVersion = nil
			m.ReleaseURL = nil
			m.ReleasedAt = nil
			m.ReleaseNotes = ""
			m.Announcements = []Announcement{}
		case 3:
			w.Write([]byte(`{"schemaVersion":1}`))
			return
		}
		json.NewEncoder(w).Encode(m)
	}))
	defer server.Close()
	m := New(context.Background(), "1.9.0", server.URL, server.Client())
	defer m.Close()
	now := time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC)
	m.now = func() time.Time { return now }
	if m.Snapshot().Status != "unchecked" {
		t.Fatal("not unchecked")
	}
	s := m.Check(context.Background())
	if s.Status != "ok" || !s.UpdateAvailable || len(s.Announcements) != 1 {
		t.Fatalf("bad success %+v", s)
	}
	success := *s.LastSuccessAt
	mode.Store(1)
	s = m.Check(context.Background())
	if calls.Load() != 1 || !s.CheckedAt.Equal(success) {
		t.Fatal("throttle failed")
	}
	now = now.Add(time.Minute)
	s = m.Check(context.Background())
	if s.Status != "error" || *s.LatestVersion != "1.10.0" || !s.LastSuccessAt.Equal(success) || len(s.Announcements) != 1 {
		t.Fatalf("lost success %+v", s)
	}
	now = now.Add(time.Minute)
	mode.Store(3)
	s = m.Check(context.Background())
	if len(s.Announcements) != 1 {
		t.Fatal("malformed replaced snapshot")
	}
	now = now.Add(time.Minute)
	mode.Store(2)
	s = m.Check(context.Background())
	if s.Status != "error" || len(s.Announcements) != 0 || *s.LatestVersion != "1.10.0" {
		t.Fatal("partial release/announcement replacement", s)
	}
	now = now.Add(time.Minute)
	mode.Store(0)
	if s = m.Check(context.Background()); s.Status != "ok" || !s.LastSuccessAt.After(success) {
		t.Fatal("did not recover")
	}
	disabled := New(context.Background(), "dev", "", nil)
	defer disabled.Close()
	if disabled.Check(context.Background()).Status != "disabled" {
		t.Fatal("not disabled")
	}
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestConcurrentChecksAndShutdown(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer server.Close()
	owner, stop := context.WithCancel(context.Background())
	defer stop()
	m := New(owner, "1.0.0", server.URL, server.Client())
	defer m.Close()
	caller, cancel := context.WithCancel(context.Background())
	first := make(chan struct{})
	go func() { defer close(first); m.Check(caller) }()
	<-started
	cancel()
	<-first
	select {
	case <-cancelled:
		t.Fatal("caller cancelled shared request")
	default:
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); m.Check(context.Background()) }()
	}
	stop()
	m.Close()
	wg.Wait()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream not cancelled")
	}
	if calls.Load() != 1 {
		t.Fatal("not single flight", calls.Load())
	}
	m.Check(context.Background())
	if calls.Load() != 1 {
		t.Fatal("request after close")
	}
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestValidationAndExpiry(t *testing.T) {
	for _, body := range []string{`{}`, `null`, strings.Repeat(" ", MaxResponseBytes+1), `{"schemaVersion":1,"latestVersion":null,"releaseUrl":null,"releasedAt":null,"releaseNotes":null,"announcements":[]}`} {
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
		m := New(context.Background(), "1.0.0", server.URL, server.Client())
		if m.Check(context.Background()).Status != "error" {
			t.Fatal("accepted invalid body")
		}
		m.Close()
		server.Close()
	}
	m := New(context.Background(), "dev", "", nil)
	defer m.Close()
	a := manifest().Announcements[0]
	expires := time.Now().Add(-time.Minute)
	a.ExpiresAt = &expires
	m.state.Announcements = []Announcement{a}
	if len(m.Snapshot().Announcements) != 0 {
		t.Fatal("expired notice retained")
	}
	for _, mutate := range []func(*Manifest){func(m *Manifest) { m.Announcements = append(m.Announcements, m.Announcements[0]) }, func(m *Manifest) { bad := "javascript:alert(1)"; m.ReleaseURL = &bad }, func(m *Manifest) { m.Announcements[0].PublishedAt = time.Time{} }, func(m *Manifest) { m.Announcements[0].Severity = "unknown" }} {
		value := manifest()
		mutate(&value)
		body, _ := json.Marshal(value)
		if _, err := decodeManifest(body); err == nil {
			t.Fatal("accepted malformed manifest")
		}
	}
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestRunCancellationAndRedirectRefusal(t *testing.T) {
	var targetCalls atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls.Add(1) }))
	defer target.Close()
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer source.Close()
	ctx, cancel := context.WithCancel(context.Background())
	m := New(ctx, "1.0.0", source.URL, source.Client())
	defer m.Close()
	if m.Check(context.Background()).Status != "error" || targetCalls.Load() != 0 {
		t.Fatal("redirect accepted")
	}
	done := make(chan struct{})
	go func() { defer close(done); m.Run() }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not terminate")
	}
}

// @use-case docs/feature/updates/use-case/check-updates.md
func TestRequestTimeout(t *testing.T) {
	cancelled := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done(); close(cancelled) }))
	defer server.Close()
	m := New(context.Background(), "1.0.0", server.URL, server.Client())
	defer m.Close()
	started := time.Now()
	if m.Check(context.Background()).Status != "error" {
		t.Fatal("timeout was not a failed check")
	}
	if time.Since(started) > 7*time.Second {
		t.Fatal("timeout exceeded bound")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("timed out upstream did not cancel")
	}
}
