// @concord-file
// @concord-implements docs/feature/people/use-case/recognize-speaker.md
package voiceprints

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"

	sherpa "github.com/k2-fsa/sherpa-onnx-go/sherpa_onnx"
)

//go:embed assets/campplus.onnx
var modelData []byte

const modelSHA = "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11"

// Engine owns native resources. The slot covers initialization, inference and
// destruction; cancellation never abandons a native call still using them.
type Engine struct {
	tempDir   string
	slot      chan struct{}
	extractor *sherpa.SpeakerEmbeddingExtractor
	closed    bool
}

func NewEngine(tempDir string) *Engine {
	return &Engine{tempDir: tempDir, slot: make(chan struct{}, 1)}
}
func (e *Engine) Close() {
	e.slot <- struct{}{}
	defer func() { <-e.slot }()
	if e.extractor != nil {
		sherpa.DeleteSpeakerEmbeddingExtractor(e.extractor)
		e.extractor = nil
	}
	e.closed = true
}
func (e *Engine) initialize() error {
	if fmt.Sprintf("%x", sha256.Sum256(modelData)) != modelSHA {
		return errors.New("model_mismatch")
	}
	dir, err := os.MkdirTemp(e.tempDir, "voices-model-")
	if err != nil {
		return errors.New("inference_unavailable")
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "model.onnx")
	if err = os.WriteFile(path, modelData, 0600); err != nil {
		return errors.New("inference_unavailable")
	}
	e.extractor = sherpa.NewSpeakerEmbeddingExtractor(&sherpa.SpeakerEmbeddingExtractorConfig{Model: path, NumThreads: 2, Provider: "cpu"})
	if e.extractor == nil {
		return errors.New("inference_unavailable")
	}
	if e.extractor.Dim() != Dimensions {
		sherpa.DeleteSpeakerEmbeddingExtractor(e.extractor)
		e.extractor = nil
		return errors.New("model_mismatch")
	}
	return nil
}
func (e *Engine) Extract(ctx context.Context, pcm []byte) ([]float64, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(pcm) < 96000 || len(pcm) > 320000 || len(pcm)%2 != 0 {
		return nil, ErrAudio
	}
	samples := make([]float32, len(pcm)/2)
	energy, clipped := 0.0, 0
	for i := range samples {
		v := float64(int16(binary.LittleEndian.Uint16(pcm[2*i:]))) / 32768
		samples[i] = float32(v)
		energy += v * v
		if math.Abs(v) > .99 {
			clipped++
		}
	}
	if math.Sqrt(energy/float64(len(samples))) < .003 || float64(clipped)/float64(len(samples)) > .05 {
		return nil, ErrAudio
	}
	select {
	case e.slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-e.slot }()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if e.closed {
		return nil, errors.New("inference_closed")
	}
	if e.extractor == nil {
		if err := e.initialize(); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	stream := e.extractor.CreateStream()
	if stream == nil {
		return nil, errors.New("inference_unavailable")
	}
	defer sherpa.DeleteOnlineStream(stream)
	stream.AcceptWaveform(16000, samples)
	stream.InputFinished()
	if !e.extractor.IsReady(stream) {
		return nil, ErrAudio
	}
	native := e.extractor.Compute(stream)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	v := make([]float64, len(native))
	for i, x := range native {
		v[i] = float64(x)
	}
	return Normalize(v)
}
