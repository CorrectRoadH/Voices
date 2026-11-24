package providers

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
)

const (
	elevenLabsBaseURL    = "https://api.elevenlabs.io"
	elevenLabsSubmitPath = "/v1/speech-to-text"
	elevenLabsResultPath = elevenLabsSubmitPath + "/transcripts/"
	// The service requires a file strictly below 5 GB.
	elevenLabsMaxFileBytes = 4_999_999_999
)

// Use ISO 639-1 where available and ISO 639-3 for the remaining Scribe v2 languages.
// https://elevenlabs.io/docs/overview/capabilities/speech-to-text#supported-languages
var elevenLabsCatalog = []Model{{
	ID: "scribe_v2", Name: "Scribe v2",
	Languages:     strings.Fields("af am ar hy as ast az be bn bs bg my yue ca ceb ny hr cs da nl en et fil fi fr ff gl lg ka de el gu ha he hi hu is ig id ga it ja jv kea kn kk km ko ku ky lo lv ln lt luo lb mk ms ml mt zh mi mr mn ne nso no oc or ps fa pl pt pa ro ru sr sn sd si sk sl so es sw sv ta tg te th tr uk umb ur uz vi cy wo xh yo zu"),
	LanguageModes: []string{"auto", "single"}, Diarization: true, Timestamps: true,
	MaxDurationMS: 10 * 60 * 60 * 1000, MaxFileBytes: elevenLabsMaxFileBytes,
}}

type elevenLabs struct{ remoteHTTP }

func NewElevenLabs(apiKey string) FileSubmitAdapter {
	remote := newRemoteHTTP(elevenLabsBaseURL, apiKey)
	remote.apiKeyHeader = "xi-api-key"
	return &elevenLabs{remote}
}

func (*elevenLabs) ID() string      { return "elevenlabs" }
func (*elevenLabs) Models() []Model { return cloneModels(elevenLabsCatalog) }

// @concord-code
// @concord-implements docs/feature/transcription/use-case/transcribe.md#choose-options
// @concord-implements docs/feature/transcription/use-case/transcribe.md#submit
func (a *elevenLabs) SubmitFile(ctx context.Context, audio io.Reader, filename string, size int64, o Options) (Resource, error) {
	if audio == nil || size <= 0 || size > elevenLabsMaxFileBytes || filename == "" || len(filename) > 255 || strings.ContainsAny(filename, "\x00\r\n") {
		return Resource{}, localError("invalid")
	}
	if err := validateOptions(a.ID(), elevenLabsCatalog, o); err != nil {
		return Resource{}, err
	}
	var framing bytes.Buffer
	w := multipart.NewWriter(&framing)
	for _, field := range [][2]string{
		{"model_id", o.Model}, {"diarize", "true"}, {"timestamps_granularity", "word"}, {"tag_audio_events", "false"}, {"webhook", "false"},
	} {
		if err := w.WriteField(field[0], field[1]); err != nil {
			return Resource{}, localError("invalid")
		}
	}
	if o.LanguageMode == "single" {
		if err := w.WriteField("language_code", o.Languages[0]); err != nil {
			return Resource{}, localError("invalid")
		}
	}
	if _, err := w.CreateFormFile("file", filepath.Base(filename)); err != nil {
		return Resource{}, localError("invalid")
	}
	prefixLen := framing.Len()
	if err := w.Close(); err != nil {
		return Resource{}, localError("invalid")
	}
	body := io.MultiReader(bytes.NewReader(framing.Bytes()[:prefixLen]), &exactAudioReader{ctx, audio, size}, bytes.NewReader(framing.Bytes()[prefixLen:]))
	data, err := a.request(ctx, http.MethodPost, elevenLabsSubmitPath, w.FormDataContentType(), body, int64(framing.Len())+size, true, false)
	if err != nil {
		return Resource{}, err
	}
	var response struct {
		ID string `json:"transcription_id"`
	}
	if err := decode(data, &response, true); err != nil {
		return Resource{}, err
	}
	if !validID(response.ID) {
		return Resource{}, operationError(true, "invalid_resource")
	}
	return Resource{ID: response.ID, Kind: "transcription"}, nil
}

type elevenLabsWord struct {
	Text    string   `json:"text"`
	Type    string   `json:"type"`
	Start   *float64 `json:"start"`
	End     *float64 `json:"end"`
	Speaker *string  `json:"speaker_id"`
}

// @concord-code
// @concord-implements docs/feature/transcription/use-case/transcribe.md#complete
func (a *elevenLabs) FetchResult(ctx context.Context, resource Resource) (Result, error) {
	path, err := transcriptionPath(resource, elevenLabsResultPath)
	if err != nil {
		return Result{}, err
	}
	data, err := a.request(ctx, http.MethodGet, path, "", nil, 0, false, false)
	if err != nil {
		return Result{}, err
	}
	var response struct {
		ID    string           `json:"transcription_id"`
		Text  *string          `json:"text"`
		Words []elevenLabsWord `json:"words"`
	}
	if err := decode(data, &response, false); err != nil {
		return Result{}, err
	}
	if response.ID != "" && response.ID != resource.ID {
		return Result{}, operationError(false, "invalid_resource")
	}
	if response.Text == nil && response.Words == nil {
		return Result{}, operationError(false, "invalid_json")
	}
	segments := normalizeElevenLabs(response.Words)
	if len(segments) == 0 && response.Text != nil && strings.TrimSpace(*response.Text) != "" {
		segments = append(segments, Segment{Text: *response.Text})
	}
	return Result{Segments: segments, Raw: data}, nil
}

// @concord-code
// @concord-implements docs/feature/transcription/use-case/transcribe.md#elevenlabs-scribe
func (a *elevenLabs) DeleteResource(ctx context.Context, resource Resource) error {
	path, err := transcriptionPath(resource, elevenLabsResultPath)
	if err != nil {
		return err
	}
	_, err = a.request(ctx, http.MethodDelete, path, "", nil, 0, false, false)
	var providerErr *Error
	if errors.As(err, &providerErr) && providerErr.Code == "not_found" {
		return nil
	}
	return err
}

func normalizeElevenLabs(words []elevenLabsWord) []Segment {
	segments := []Segment{}
	var text strings.Builder
	var spoken []assemblyWord
	var speaker *string
	var lastWord string
	var spacing, lineBreak bool
	flush := func() {
		if len(spoken) > 0 {
			start, end := wordRange(spoken)
			segments = append(segments, Segment{Text: text.String(), StartMS: start, EndMS: end, Speaker: speaker})
		}
		text.Reset()
		spoken = nil
	}
	for _, word := range words {
		if word.Text == "" {
			continue
		}
		if word.Type == "spacing" || strings.TrimSpace(word.Text) == "" {
			text.WriteString(word.Text)
			spacing = true
			lineBreak = lineBreak || strings.ContainsAny(word.Text, "\r\n")
			continue
		}
		next := word.Text
		if spacing {
			next = " "
		}
		sp := cleanSpeaker(word.Speaker)
		if len(spoken) > 0 && (lineBreak || !speakerEqual(speaker, sp) || sonioxSentenceBoundary(lastWord, next)) {
			flush()
		}
		text.WriteString(word.Text)
		start, end := elevenLabsTimeRange(word.Start, word.End)
		spoken = append(spoken, assemblyWord{Start: start, End: end})
		speaker, lastWord = sp, word.Text
		spacing, lineBreak = false, false
	}
	flush()
	return segments
}

func elevenLabsTimeRange(start, end *float64) (*int64, *int64) {
	if start == nil || end == nil || *start < 0 || *end < *start || *end >= float64(math.MaxInt64)/1000 {
		return nil, nil
	}
	startMS, endMS := int64(math.Round(*start*1000)), int64(math.Round(*end*1000))
	return &startMS, &endMS
}
