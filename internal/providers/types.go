// Package providers isolates remote speech-to-text APIs from durable application state.
package providers

import (
	"context"
	"io"
)

type Options struct {
	Provider     string   `json:"provider"`
	Model        string   `json:"model"`
	LanguageMode string   `json:"language_mode"`
	Languages    []string `json:"languages"`
	Diarization  bool     `json:"diarization"`
}

type Model struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Languages     []string `json:"languages"`
	LanguageModes []string `json:"language_modes"`
	Diarization   bool     `json:"diarization"`
	Timestamps    bool     `json:"timestamps"`
	MaxDurationMS int64    `json:"max_duration_ms"`
	MaxFileBytes  int64    `json:"max_file_bytes"`
}

type Resource struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // file or transcription
}

type RemoteState struct {
	State     string // pending, running, completed, failed
	ErrorCode string // sanitized machine code; never raw credentials/body
}

type Segment struct {
	Text    string  `json:"text"`
	StartMS *int64  `json:"start_ms"`
	EndMS   *int64  `json:"end_ms"`
	Speaker *string `json:"speaker"`
}

type Result struct {
	Segments []Segment
	Raw      []byte
}

// Adapter performs one remote step. It never retries creation requests, polls in
// a loop, persists state, or falls back to another provider. The caller owns those.
type Adapter interface {
	ID() string
	Models() []Model
	Upload(context.Context, io.Reader, string, int64) (Resource, error)
	Submit(context.Context, Resource, Options) (Resource, error)
	Poll(context.Context, Resource) (RemoteState, error)
	FetchResult(context.Context, Resource) (Result, error)
	DeleteResource(context.Context, Resource) error
}

// Error.Code is auth, invalid, rate_limited, transient, uncertain, unsupported,
// or not_found. Definitive means a creation request provably created no resource.
// Transport errors on Upload/Submit must be uncertain, never auto-retried.
type Error struct {
	Code              string
	Definitive        bool
	RetryAfterSeconds int
}

func (e *Error) Error() string { return "provider: " + e.Code }
