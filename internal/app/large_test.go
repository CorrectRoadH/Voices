package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

// @use-case docs/feature/stateless-deployment/use-case/replace-instance.md
func TestLargeHTTPUploadsBoundedMemory(t *testing.T) {
	if os.Getenv("VOICES_LARGE_TEST") != "1" {
		t.Skip("set VOICES_LARGE_TEST=1 for >1 GiB and near-2 GiB real HTTP/PostgreSQL uploads")
	}
	f := setup(t)
	for _, size := range []int64{(1 << 30) + 44, (2 << 30) - (1 << 20)} {
		t.Run(stringSize(size), func(t *testing.T) {
			head := wav(0)
			binary.LittleEndian.PutUint32(head[4:8], uint32(size-8))
			binary.LittleEndian.PutUint32(head[40:44], uint32(size-44))
			pipeR, pipeW := io.Pipe()
			multi := multipart.NewWriter(pipeW)
			done := make(chan error, 1)
			go func() {
				meta, err := multi.CreateFormField("metadata")
				if err == nil {
					_, err = meta.Write([]byte(`{"auto_transcribe":false}`))
				}
				if err == nil {
					var file io.Writer
					file, err = multi.CreateFormFile("file", "large.wav")
					if err == nil {
						_, err = io.Copy(file, io.MultiReader(bytes.NewReader(head), io.LimitReader(zeroReader{}, size-44)))
					}
				}
				if err == nil {
					err = multi.Close()
				}
				pipeW.CloseWithError(err)
				done <- err
			}()
			var peak atomic.Uint64
			stop := make(chan struct{})
			sampleDone := make(chan struct{})
			go func() {
				defer close(sampleDone)
				timer := time.NewTicker(10 * time.Millisecond)
				defer timer.Stop()
				for {
					select {
					case <-stop:
						return
					case <-timer.C:
						var m runtime.MemStats
						runtime.ReadMemStats(&m)
						if m.HeapAlloc > peak.Load() {
							peak.Store(m.HeapAlloc)
						}
					}
				}
			}()
			req, _ := http.NewRequest("POST", f.server.URL+"/api/v1/recordings", pipeR)
			req.Header.Set("Content-Type", multi.FormDataContentType())
			req.Header.Set("X-CSRF-Token", f.csrf)
			req.Header.Set("Idempotency-Key", uuid.NewString())
			resp, err := f.client.Do(req)
			pipeR.Close()
			producerErr := <-done
			close(stop)
			<-sampleDone
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != 201 {
				t.Fatalf("large upload=%d %s", resp.StatusCode, raw)
			}
			if producerErr != nil {
				t.Fatal(producerErr)
			}
			var result struct {
				Recording struct {
					ID   string `json:"id"`
					Size int64  `json:"size_bytes"`
				} `json:"recording"`
			}
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			if result.Recording.Size != size {
				t.Fatalf("size=%d expected %d", result.Recording.Size, size)
			}
			var chunks int
			var sum int64
			err = f.db.QueryRow(context.Background(), "SELECT count(*),sum(octet_length(c.data)) FROM blob_chunks c JOIN media_assets m ON m.blob_id=c.blob_id WHERE m.recording_id=$1", result.Recording.ID).Scan(&chunks, &sum)
			if err != nil {
				t.Fatal(err)
			}
			if chunks < 1024 || sum != size {
				t.Fatalf("manifest count=%d sum=%d", chunks, sum)
			}
			t.Logf("upload bytes=%d chunks=%d peak Go heap=%d MiB", size, chunks, peak.Load()>>20)
			if peak.Load() > 256<<20 {
				t.Fatalf("heap exceeds bounded-memory budget: %d", peak.Load())
			}
		})
	}
}
func stringSize(n int64) string {
	if n > 2<<30-1<<20-1 {
		return "near_2GiB"
	}
	return "over_1GiB"
}
