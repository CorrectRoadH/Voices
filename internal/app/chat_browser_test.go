package app

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/google/uuid"
)

// @use-case docs/feature/transcription/use-case/read-transcript.md
func TestTranscriptChatBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	fakeRemote(t)
	f := setup(t)
	out := f.upload(t, wav(20), map[string]any{"title": "连续发言阅读", "auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	j := f.run(t, "transcribe")
	_, person := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "本人"}, 201, uuid.NewString())
	f.json(t, "PATCH", "/api/v1/people/"+person["id"].(string), map[string]any{"revision": person["revision"], "is_self": true}, 200, "")
	// Seed consecutive turns and a long sentence to exercise layout; production reading,
	// playback, menus, selection and reference creation all run through their real entry points.
	ctx := context.Background()
	_, err := f.db.Exec(ctx, `UPDATE speaker_labels SET person_id=$2 WHERE transcription_id=$1 AND provider_label='B'`, *j.TranscriptionID, person["id"])
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.Exec(ctx, `UPDATE segments s SET source_speaker_label_id=l.id,source_text=CASE WHEN s.ordinal=4 THEN '这是一段较长的连续发言，用来检查聊天气泡在桌面与手机上的换行效果。阅读时应该能自然地接着上一句话，不需要在屏幕两端反复寻找下一段。' ELSE '第 '||s.ordinal::text||' 句：保持每句话独立播放和引用。' END FROM speaker_labels l WHERE s.transcription_id=$1 AND l.transcription_id=s.transcription_id AND l.provider_label=CASE WHEN s.ordinal%8<4 THEN 'A' ELSE 'B' END`, *j.TranscriptionID)
	if err != nil {
		t.Fatal(err)
	}
	f.a.Config.WebDir = "../../web/dist"
	cmdCtx, stop := context.WithTimeout(ctx, 3*time.Minute)
	defer stop()
	cmd := exec.CommandContext(cmdCtx, "vp", "exec", "node", "tests/chat.browser.mjs")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "VOICES_TEST_URL="+f.server.URL, "VOICES_TEST_RECORDING="+rid)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}
