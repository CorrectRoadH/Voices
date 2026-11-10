// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime/multipart"
	"path/filepath"
	"slices"
	"strings"
)

const DefaultOpenAIBaseURL = "https://api.openai.com/v1"
const OpenAIMaxFileBytes int64 = 25_000_000

// Official speech-to-text supported languages; only automatic and single
// language selection are supported by this model, never multilingual hints.
var openaiCatalog = []Model{{
	ID: "gpt-4o-transcribe-diarize", Name: "GPT-4o Transcribe Diarize",
	Languages:     strings.Fields("af ar hy az be bs bg ca zh hr cs da nl en et fi fr gl de el he hi hu is id it ja kn kk ko lv lt mk ms mr mi ne no fa pl pt ro ru sr sk sl es sw sv tl ta th tr uk ur vi cy"),
	LanguageModes: []string{"auto", "single"}, Diarization: true, Timestamps: true, MaxFileBytes: OpenAIMaxFileBytes,
}}

type openai struct{ remoteHTTP }

// NewOpenAI uses only explicit STT configuration, never LLM or SDK environment.
func NewOpenAI(baseURL, apiKey string) DirectAdapter {
	baseURL = strings.TrimRight(baseURL, "/")
	if baseURL == "" {
		baseURL = DefaultOpenAIBaseURL
	}
	return &openai{newRemoteHTTP(baseURL, apiKey)}
}
func (*openai) ID() string      { return "openai" }
func (*openai) Models() []Model { return cloneModels(openaiCatalog) }

func ValidOpenAIFilename(filename string) bool {
	return filename != "" && len(filename) <= 255 && !strings.ContainsAny(filename, "\r\n") && slices.Contains([]string{".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"}, strings.ToLower(filepath.Ext(filename)))
}

func directError(err error) error {
	var pe *Error
	if errors.As(err, &pe) {
		copy := *pe
		copy.Code = "direct_" + pe.Code
		return &copy
	}
	return &Error{Code: "direct_request_failed"}
}

func (a *openai) Transcribe(ctx context.Context, audio io.Reader, filename string, size int64, o Options) (Result, error) {
	if audio == nil || size <= 0 || size > OpenAIMaxFileBytes {
		return Result{}, localError("direct_invalid_file_size")
	}
	if !ValidOpenAIFilename(filename) {
		return Result{}, localError("direct_unsupported_format")
	}
	if err := validateOptions(a.ID(), openaiCatalog, o); err != nil {
		return Result{}, directError(err)
	}
	var framing bytes.Buffer
	w := multipart.NewWriter(&framing)
	for _, field := range [][2]string{{"model", o.Model}, {"response_format", "diarized_json"}, {"chunking_strategy", "auto"}} {
		if err := w.WriteField(field[0], field[1]); err != nil {
			return Result{}, localError("direct_invalid")
		}
	}
	if o.LanguageMode == "single" {
		if err := w.WriteField("language", o.Languages[0]); err != nil {
			return Result{}, localError("direct_invalid")
		}
	}
	if _, err := w.CreateFormFile("file", filepath.Base(filename)); err != nil {
		return Result{}, localError("direct_invalid")
	}
	prefixLen := framing.Len()
	if err := w.Close(); err != nil {
		return Result{}, localError("direct_invalid")
	}
	body := io.MultiReader(bytes.NewReader(framing.Bytes()[:prefixLen]), &exactAudioReader{ctx, audio, size}, bytes.NewReader(framing.Bytes()[prefixLen:]))
	data, err := a.request(ctx, "POST", "/audio/transcriptions", w.FormDataContentType(), body, int64(framing.Len())+size, true, true)
	if err != nil {
		return Result{}, directError(err)
	}
	var response struct {
		Segments []struct {
			Text    *string  `json:"text"`
			Speaker *string  `json:"speaker"`
			Start   *float64 `json:"start"`
			End     *float64 `json:"end"`
		} `json:"segments"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return Result{}, localError("direct_invalid_result")
	}
	if len(response.Segments) == 0 {
		return Result{}, localError("direct_invalid_result")
	}
	result := Result{Raw: data}
	for _, s := range response.Segments {
		if s.Text == nil || s.Speaker == nil || strings.TrimSpace(*s.Speaker) == "" || s.Start == nil || s.End == nil {
			return Result{}, localError("direct_invalid_result")
		}
		start, end := *s.Start, *s.End
		if math.IsNaN(start) || math.IsNaN(end) || math.IsInf(start, 0) || math.IsInf(end, 0) || start < 0 || end < start || end >= float64(math.MaxInt64)/1000 {
			return Result{}, localError("direct_invalid_result")
		}
		startMS, endMS := int64(math.Round(start*1000)), int64(math.Round(end*1000))
		result.Segments = append(result.Segments, Segment{Text: *s.Text, Speaker: s.Speaker, StartMS: &startMS, EndMS: &endMS})
	}
	return result, nil
}
