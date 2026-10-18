package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// A response is bounded independently of audio size. Five-hour transcripts fit
// comfortably; an oversized/malformed creation response remains uncertain.
const maxResponseBytes = 64 << 20

type remoteHTTP struct {
	baseURL string
	apiKey  string
	client  *http.Client
}

func newRemoteHTTP(base, key string) remoteHTTP {
	return remoteHTTP{baseURL: base, apiKey: key, client: &http.Client{Timeout: 30 * time.Minute}}
}

func localError(code string) error { return &Error{Code: code, Definitive: true} }

func operationError(creation bool) error {
	if creation {
		return &Error{Code: "uncertain"}
	}
	return &Error{Code: "transient"}
}

// Never follow redirects, including 307/308 POST redirects. A redirect may have
// followed acceptance, and following it could create a second resource or leak
// the key. Copying the client preserves package-test transport injection.
func (h *remoteHTTP) request(ctx context.Context, method, path, contentType string, body io.Reader, size int64, creation bool, bearer bool) ([]byte, error) {
	if strings.TrimSpace(h.apiKey) == "" {
		return nil, localError("auth")
	}
	req, err := http.NewRequestWithContext(ctx, method, h.baseURL+path, body)
	if err != nil {
		return nil, localError("invalid")
	}
	if body != nil {
		req.ContentLength = size
	}
	// NewRequest recognizes bytes.Reader and installs GetBody automatically.
	// Disable replay so Transport cannot retry a POST on a stale connection,
	// even when it believes no bytes of that request were written.
	if creation {
		req.GetBody = nil
	}
	key := h.apiKey
	if bearer {
		key = "Bearer " + key
	}
	req.Header.Set("Authorization", key)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	client := *h.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return nil, operationError(creation)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Do not read or return an error body: upstream messages may echo secrets.
		return nil, responseError(resp, creation)
	}
	// These APIs document completed deletion as 204 (Soniox) or 200
	// (AssemblyAI). An unexpected 202 is acceptance, not proof of cleanup.
	if method == http.MethodDelete && (bearer && resp.StatusCode != http.StatusNoContent || !bearer && resp.StatusCode != http.StatusOK) {
		return nil, operationError(false)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(data) > maxResponseBytes {
		return nil, operationError(creation)
	}
	return data, nil
}

func responseError(resp *http.Response, creation bool) error {
	e := &Error{Code: "transient"}
	switch resp.StatusCode {
	case 400, 413, 415, 422:
		e.Code, e.Definitive = "invalid", true
	case 401, 402, 403:
		e.Code, e.Definitive = "auth", true
	case 404:
		e.Code, e.Definitive = "not_found", true
	case 429:
		e.Code, e.Definitive = "rate_limited", true
	default:
		if creation {
			e.Code = "uncertain"
		}
	}
	// Definitive is only meaningful for creations; reads/deletes cannot supply
	// evidence about a previous creation operation.
	if !creation {
		e.Definitive = false
	}
	if n, err := strconv.ParseInt(resp.Header.Get("Retry-After"), 10, 32); err == nil && n >= 0 {
		e.RetryAfterSeconds = int(n)
	} else if when, err := http.ParseTime(resp.Header.Get("Retry-After")); err == nil {
		n := math.Ceil(time.Until(when).Seconds())
		if n > 0 {
			e.RetryAfterSeconds = int(min(n, math.MaxInt32))
		}
	}
	return e
}

func (h *remoteHTTP) json(ctx context.Context, method, path string, value any, creation, bearer bool) ([]byte, error) {
	var body io.Reader
	var size int64
	if value != nil {
		data, err := json.Marshal(value)
		if err != nil {
			return nil, localError("invalid")
		}
		body, size = bytes.NewReader(data), int64(len(data))
	}
	return h.request(ctx, method, path, "application/json", body, size, creation, bearer)
}

func decode(data []byte, value any, creation bool) error {
	if err := json.Unmarshal(data, value); err != nil {
		return operationError(creation)
	}
	return nil
}

func validID(id string) bool {
	if id == "" || id == "." || id == ".." || len(id) > 256 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func transcriptionPath(r Resource, prefix string) (string, error) {
	if r.Kind != "transcription" || !validID(r.ID) {
		return "", localError("invalid")
	}
	return prefix + r.ID, nil
}

func remoteState(status string) (RemoteState, error) {
	switch status {
	case "queued":
		return RemoteState{State: "pending"}, nil
	case "processing":
		return RemoteState{State: "running"}, nil
	case "completed":
		return RemoteState{State: "completed"}, nil
	case "error":
		return RemoteState{State: "failed", ErrorCode: "transcription_failed"}, nil
	default:
		return RemoteState{}, operationError(false)
	}
}

// exactAudioReader has constant memory, doesn't take ownership of the caller's
// reader, observes cancellation, and detects a truncated input before sending a
// multipart closing delimiter. Reader errors are never exposed in public errors.
type exactAudioReader struct {
	ctx       context.Context
	source    io.Reader
	remaining int64
}

func (r *exactAudioReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	if r.remaining == 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	n, err := r.source.Read(p)
	r.remaining -= int64(n)
	if err == io.EOF {
		if r.remaining != 0 {
			err = io.ErrUnexpectedEOF
		} else {
			err = nil
		}
	}
	return n, err
}
