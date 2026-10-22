package providers

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// @use-case docs/feature/transcription/use-case/transcribe.md
func TestCreationDiagnosticsPreserveSafetyAndExcludeSecrets(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		for _, tc := range []struct {
			name               string
			status             int
			body, reason, code string
			definitive         bool
		}{
			{"unavailable", 503, testKey, "http_status", "uncertain", false},
			{"auth", 401, testKey, "http_status", "auth", true},
			{"json", 200, "invalid " + testKey, "invalid_json", "uncertain", false},
			{"resource", 200, `{"id":"../secret","upload_url":"file:///secret"}`, "invalid_resource", "uncertain", false},
		} {
			t.Run(provider+"/"+tc.name, func(t *testing.T) {
				calls := 0
				a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
					calls++
					io.Copy(io.Discard, r.Body)
					w.WriteHeader(tc.status)
					io.WriteString(w, tc.body)
				})
				_, err := a.Upload(context.Background(), strings.NewReader("audio"), "audio.wav", 5)
				var pe *Error
				if !errors.As(err, &pe) || pe.Code != tc.code || pe.Definitive != tc.definitive || calls != 1 {
					t.Fatalf("unexpected error/calls: %v %d", err, calls)
				}
				d := pe.Diagnostic()
				if d == nil || d.Reason != tc.reason {
					t.Fatalf("diagnostic=%+v", d)
				}
				if tc.status != 200 && d.HTTPStatus != tc.status {
					t.Fatalf("missing HTTP status: %+v", d)
				}
				b, _ := json.Marshal(d)
				if strings.Contains(string(b), testKey) || strings.Contains(string(b), "secret") {
					t.Fatal("sensitive diagnostic")
				}
			})
		}
	}
}

func TestTransportDiagnosticsAreBounded(t *testing.T) {
	for _, tc := range []struct {
		err    error
		reason string
	}{
		{context.DeadlineExceeded, "timeout"}, {context.Canceled, "cancelled"},
		{&net.DNSError{Err: testKey, Name: testKey}, "dns"},
		{tls.RecordHeaderError{Msg: testKey}, "tls"}, {fmt.Errorf("secret %s", testKey), "connection"},
	} {
		err := &url.Error{Op: "POST", URL: "https://" + testKey, Err: tc.err}
		pe := operationError(true, transportReason(err))
		if pe.Code != "uncertain" || pe.Definitive || pe.Diagnostic().Reason != tc.reason {
			t.Fatalf("unexpected diagnostic %+v", pe)
		}
	}
	if (&Error{Reason: testKey, HTTPStatus: 503}).Diagnostic() != nil {
		t.Fatal("unknown reason leaked")
	}
	if (&Error{Reason: "timeout", HTTPStatus: 999}).Diagnostic().HTTPStatus != 0 {
		t.Fatal("invalid status leaked")
	}
}
