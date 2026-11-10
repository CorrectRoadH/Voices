package app

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
	"voices/internal/providers"

	"github.com/google/uuid"
)

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintAir(t *testing.T) {
	if os.Getenv("VOICES_AIR_TEST") != "1" {
		t.Skip("set VOICES_AIR_TEST=1 to exercise local Air with native inference")
	}
	fakeRemote(t)
	f := setup(t)
	dir := t.TempDir()
	audio := filepath.Join(dir, "speech.wav")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-stream_loop", "-1", "-i", "../voiceprints/testdata/speech.wav", "-t", "20", "-acodec", "pcm_s16le", audio).CombinedOutput(); err != nil {
		t.Fatalf("speech fixture: %v %s", err, out)
	}
	raw, err := os.ReadFile(audio)
	if err != nil {
		t.Fatal(err)
	}
	f.a.Providers["soniox"] = voiceprintSTT{f.a.Providers["soniox"].(providers.AsyncAdapter)}
	seed := func(title string) (string, string) {
		f.upload(t, raw, map[string]any{"title": title, "auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
		f.run(t, "prepare")
		j := f.run(t, "transcribe")
		var label string
		if err := f.db.QueryRow(context.Background(), "SELECT id FROM speaker_labels WHERE transcription_id=$1", *j.TranscriptionID).Scan(&label); err != nil {
			t.Fatal(err)
		}
		return *j.TranscriptionID, label
	}
	tid, label := seed("原生建档")
	_, person := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "公开语音人物"}, 201, uuid.NewString())
	pid := person["id"].(string)
	assignVoiceprint(t, f, label, pid)
	// Different bytes/title avoid recording content deduplication.
	raw = append(raw, 0, 0)
	tid2, label2 := seed("原生识别")
	dsn, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	q := dsn.Query()
	q.Set("search_path", f.db.Config().ConnConfig.RuntimeParams["search_path"])
	dsn.RawQuery = q.Encode()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	listener.Close()
	binary := filepath.Join(dir, "voices")
	config := filepath.Join(dir, "air.toml")
	content := fmt.Sprintf("root = \".\"\ntmp_dir = %q\n[build]\ncmd = %q\nentrypoint = [%q]\ninclude_ext = [\"go\",\"sql\"]\nexclude_dir = [\".git\",\".air\",\"web\",\"node_modules\"]\nsend_interrupt = true\nkill_delay = \"20s\"\n", dir, "./scripts/go.sh build -o "+binary+" ./cmd/voices", binary)
	if err = os.WriteFile(config, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	logFile, err := os.Create(filepath.Join(dir, "air.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	cmd := exec.Command("air", "-c", config)
	cmd.Dir = "../.."
	cmd.Env = append(os.Environ(), "DATABASE_URL="+dsn.String(), "LISTEN_ADDR="+addr, "TEMP_DIR="+dir, "PUBLIC_BASE_URL=http://"+addr, "UPDATE_URL=", "RESTORE_MODE=false")
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = cmd.Process.Signal(os.Interrupt)
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			_ = cmd.Process.Kill()
			<-done
			t.Error("Air did not stop gracefully")
		}
		b, _ := os.ReadFile(logFile.Name())
		t.Log(string(b))
	}()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err = f.db.QueryRow(context.Background(), "SELECT count(*) FROM voiceprint_tasks WHERE transcription_id IN ($1,$2) AND state='succeeded'", tid, tid2).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 2 {
			assertIdentity(t, f, label2, "automatic", pid)
			var samples int
			if err = f.db.QueryRow(context.Background(), "SELECT count(*) FROM speaker_voiceprints").Scan(&samples); err != nil || samples != 2 {
				t.Fatal("native samples", samples, err)
			}
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("Air failed to publish native voiceprints")
}
