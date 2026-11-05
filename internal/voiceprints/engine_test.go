package voiceprints

import (
	"context"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func speechPCM(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/speech.wav")
	if err != nil {
		t.Fatal(err)
	}
	for at := 12; at+8 <= len(b); {
		n := int(binary.LittleEndian.Uint32(b[at+4:]))
		if at+8+n > len(b) {
			t.Fatal("invalid WAV")
		}
		if string(b[at:at+4]) == "data" {
			return b[at+8 : at+8+n]
		}
		at += 8 + n + n%2
	}
	t.Fatal("no PCM")
	return nil
}

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintNative(t *testing.T) {
	dir := t.TempDir()
	e := NewEngine(dir)
	defer e.Close()
	pcm := speechPCM(t)
	start := time.Now()
	v, err := e.Extract(context.Background(), pcm)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("native load + inference: %s", time.Since(start))
	again, err := e.Extract(context.Background(), pcm)
	if err != nil {
		t.Fatal(err)
	}
	if len(v) != Dimensions || math.Abs(Similarity(v, v)-1) > 1e-6 || Similarity(v, again) < .99999 {
		t.Fatal("invalid/nonrepeatable embedding")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatal("model files leaked", entries, err)
	}
	e.Close()
	e.Close()
	if _, err = e.Extract(context.Background(), pcm); err == nil {
		t.Fatal("closed engine accepted work")
	}
}

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintNativeValidationCancellationAndRetry(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "missing")
	e := NewEngine(dir)
	defer e.Close()
	pcm := speechPCM(t)
	for _, bad := range [][]byte{nil, pcm[:100], make([]byte, 96000), make([]byte, 320002), make([]byte, 96001)} {
		if _, err := e.Extract(context.Background(), bad); !errors.Is(err, ErrAudio) {
			t.Fatal(err)
		}
	}
	clipped := make([]byte, 96000)
	for i := 0; i < len(clipped); i += 2 {
		binary.LittleEndian.PutUint16(clipped[i:], 32767)
	}
	if _, err := e.Extract(context.Background(), clipped); !errors.Is(err, ErrAudio) {
		t.Fatal(err)
	}
	if _, err := e.Extract(context.Background(), pcm); err == nil {
		t.Fatal("missing temp root accepted")
	}
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Extract(context.Background(), pcm); err != nil {
		t.Fatal("initialization could not retry", err)
	}
	e.slot <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := e.Extract(ctx, pcm); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() { e.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("close bypassed occupied slot")
	case <-time.After(20 * time.Millisecond):
	}
	<-e.slot
	<-closed
}
