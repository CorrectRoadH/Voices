package providers

import (
	"bytes"
	"context"
	"io"
	"math"
	"mime/multipart"
	"path/filepath"
	"strings"
)

type soniox struct{ remoteHTTP }

// NewSoniox uses the production REST API. It performs no retries or polling loop.
func NewSoniox(apiKey string) Adapter {
	return &soniox{newRemoteHTTP("https://api.soniox.com", apiKey)}
}

func (*soniox) ID() string      { return "soniox" }
func (*soniox) Models() []Model { return cloneModels(sonioxCatalog) }

// Upload sends known-length multipart without buffering audio or starting a
// producer goroutine. The source remains owned by the caller.
func (s *soniox) Upload(ctx context.Context, audio io.Reader, filename string, size int64) (Resource, error) {
	if audio == nil || size <= 0 || size > math.MaxInt64-4096 || filename == "" || len(filename) > 255 || strings.ContainsAny(filename, "\r\n") {
		return Resource{}, localError("invalid")
	}
	var framing bytes.Buffer
	w := multipart.NewWriter(&framing)
	if _, err := w.CreateFormFile("file", filepath.Base(filename)); err != nil {
		return Resource{}, localError("invalid")
	}
	prefixLen := framing.Len()
	if err := w.Close(); err != nil {
		return Resource{}, localError("invalid")
	}
	prefix := framing.Bytes()[:prefixLen]
	suffix := framing.Bytes()[prefixLen:]
	body := io.MultiReader(bytes.NewReader(prefix), &exactAudioReader{ctx, audio, size}, bytes.NewReader(suffix))
	data, err := s.request(ctx, "POST", "/v1/files", w.FormDataContentType(), body, int64(framing.Len())+size, true, true)
	if err != nil {
		return Resource{}, err
	}
	var response struct {
		ID string `json:"id"`
	}
	if err := decode(data, &response, true); err != nil {
		return Resource{}, err
	}
	if !validID(response.ID) {
		return Resource{}, operationError(true)
	}
	return Resource{ID: response.ID, Kind: "file"}, nil
}

func (s *soniox) Submit(ctx context.Context, file Resource, o Options) (Resource, error) {
	if file.Kind != "file" || !validID(file.ID) {
		return Resource{}, localError("invalid")
	}
	if err := validateOptions(s.ID(), sonioxCatalog, o); err != nil {
		return Resource{}, err
	}
	body := map[string]any{"model": o.Model, "file_id": file.ID, "enable_speaker_diarization": o.Diarization, "enable_language_identification": true}
	if o.LanguageMode != "auto" {
		body["language_hints"] = o.Languages
		body["language_hints_strict"] = true
	}
	data, err := s.json(ctx, "POST", "/v1/transcriptions", body, true, true)
	if err != nil {
		return Resource{}, err
	}
	var response struct {
		ID string `json:"id"`
	}
	if err := decode(data, &response, true); err != nil {
		return Resource{}, err
	}
	if !validID(response.ID) {
		return Resource{}, operationError(true)
	}
	return Resource{ID: response.ID, Kind: "transcription"}, nil
}

func (s *soniox) Poll(ctx context.Context, resource Resource) (RemoteState, error) {
	path, err := transcriptionPath(resource, "/v1/transcriptions/")
	if err != nil {
		return RemoteState{}, err
	}
	data, err := s.json(ctx, "GET", path, nil, false, true)
	if err != nil {
		return RemoteState{}, err
	}
	var response struct {
		Status string `json:"status"`
	}
	if err := decode(data, &response, false); err != nil {
		return RemoteState{}, err
	}
	return remoteState(response.Status)
}

func (s *soniox) FetchResult(ctx context.Context, resource Resource) (Result, error) {
	path, err := transcriptionPath(resource, "/v1/transcriptions/")
	if err != nil {
		return Result{}, err
	}
	data, err := s.json(ctx, "GET", path+"/transcript", nil, false, true)
	if err != nil {
		return Result{}, err
	}
	var response struct {
		Text   *string        `json:"text"`
		Tokens *[]sonioxToken `json:"tokens"`
	}
	if err := decode(data, &response, false); err != nil {
		return Result{}, err
	}
	if response.Text == nil && response.Tokens == nil {
		return Result{}, operationError(false)
	}
	segments := []Segment{}
	if response.Tokens != nil {
		segments = normalizeSoniox(*response.Tokens)
	}
	if len(segments) == 0 && response.Text != nil && strings.TrimSpace(*response.Text) != "" {
		segments = []Segment{{Text: *response.Text}}
	}
	return Result{Segments: segments, Raw: data}, nil
}

func (s *soniox) DeleteResource(ctx context.Context, resource Resource) error {
	if !validID(resource.ID) {
		return localError("invalid")
	}
	var path string
	switch resource.Kind {
	case "file":
		path = "/v1/files/" + resource.ID
	case "transcription":
		path = "/v1/transcriptions/" + resource.ID
	default:
		return localError("unsupported")
	}
	_, err := s.json(ctx, "DELETE", path, nil, false, true)
	return err
}
