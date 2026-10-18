package providers

import (
	"context"
	"io"
	"net/url"
	"strings"
)

type assemblyAI struct{ remoteHTTP }

// NewAssemblyAI pins the US production REST endpoint; URLs returned by Upload
// are opaque resource identifiers and are never used as authenticated targets.
func NewAssemblyAI(apiKey string) Adapter {
	return &assemblyAI{newRemoteHTTP("https://api.assemblyai.com", apiKey)}
}

func (*assemblyAI) ID() string      { return "assemblyai" }
func (*assemblyAI) Models() []Model { return cloneModels(assemblyCatalog) }

func validUploadURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Fragment == ""
}

func (a *assemblyAI) Upload(ctx context.Context, audio io.Reader, _ string, size int64) (Resource, error) {
	if audio == nil || size <= 0 || size > assemblyCatalog[0].MaxFileBytes {
		return Resource{}, localError("invalid")
	}
	data, err := a.request(ctx, "POST", "/v2/upload", "application/octet-stream", &exactAudioReader{ctx, audio, size}, size, true, false)
	if err != nil {
		return Resource{}, err
	}
	var response struct {
		URL string `json:"upload_url"`
	}
	if err := decode(data, &response, true); err != nil {
		return Resource{}, err
	}
	if !validUploadURL(response.URL) {
		return Resource{}, operationError(true)
	}
	return Resource{ID: response.URL, Kind: "file"}, nil
}

func (a *assemblyAI) Submit(ctx context.Context, file Resource, o Options) (Resource, error) {
	if file.Kind != "file" || !validUploadURL(file.ID) {
		return Resource{}, localError("invalid")
	}
	if err := validateOptions(a.ID(), assemblyCatalog, o); err != nil {
		return Resource{}, err
	}
	body := map[string]any{"audio_url": file.ID, "speech_models": []string{o.Model}, "speaker_labels": o.Diarization, "punctuate": true, "format_text": true}
	switch o.LanguageMode {
	case "auto":
		body["language_detection"] = true
	case "single":
		body["language_code"] = o.Languages[0]
	case "multi":
		body["language_codes"] = o.Languages
	}
	data, err := a.json(ctx, "POST", "/v2/transcript", body, true, false)
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

func (a *assemblyAI) Poll(ctx context.Context, resource Resource) (RemoteState, error) {
	path, err := transcriptionPath(resource, "/v2/transcript/")
	if err != nil {
		return RemoteState{}, err
	}
	data, err := a.json(ctx, "GET", path, nil, false, false)
	if err != nil {
		return RemoteState{}, err
	}
	var response struct {
		Status  string `json:"status"`
		Deleted bool   `json:"is_deleted"`
	}
	if err := decode(data, &response, false); err != nil {
		return RemoteState{}, err
	}
	if response.Deleted {
		return RemoteState{}, &Error{Code: "not_found"}
	}
	return remoteState(response.Status)
}

func (a *assemblyAI) FetchResult(ctx context.Context, resource Resource) (Result, error) {
	path, err := transcriptionPath(resource, "/v2/transcript/")
	if err != nil {
		return Result{}, err
	}
	// This is the provider's semantic sentence endpoint, not a local punctuation
	// guess. Its words carry speaker labels; split only at actual label changes.
	data, err := a.json(ctx, "GET", path+"/sentences", nil, false, false)
	if err != nil {
		return Result{}, err
	}
	var response struct {
		Sentences *[]assemblySentence `json:"sentences"`
	}
	if err := decode(data, &response, false); err != nil {
		return Result{}, err
	}
	if response.Sentences == nil {
		return Result{}, operationError(false)
	}
	segments := []Segment{}
	for _, sentence := range *response.Sentences {
		if strings.TrimSpace(sentence.Text) == "" {
			continue
		}
		segments = append(segments, normalizeAssemblySentence(sentence)...)
	}
	return Result{Segments: segments, Raw: data}, nil
}

func (a *assemblyAI) DeleteResource(ctx context.Context, resource Resource) error {
	if resource.Kind == "file" {
		// There is no DELETE-by-upload-URL API. The current retention page states
		// transcript deletion also deletes associated uploaded audio, but this
		// cannot clean up an upload that never obtained a transcript ID. Do not
		// pretend a TTL or deletion of another resource proves this file absent.
		// https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/delete
		// https://www.assemblyai.com/docs/data-retention-and-model-training
		return localError("unsupported")
	}
	path, err := transcriptionPath(resource, "/v2/transcript/")
	if err != nil {
		return err
	}
	_, err = a.json(ctx, "DELETE", path, nil, false, false)
	return err
}
