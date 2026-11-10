package app

import (
	"context"
	"github.com/google/uuid"
	"os"
	"os/exec"
	"testing"
	"time"
)

// @use-case docs/feature/stt-pricing/use-case/manage-estimates.md
func TestSTTPricingBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	fakeRemote(t)
	f := setup(t)
	savePrice(t, f, priceInput())
	f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	f.run(t, "prepare")
	f.run(t, "transcribe")
	f.a.Config.WebDir = "../../web/dist"
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "vp", "exec", "node", "tests/stt-pricing.browser.mjs")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "VOICES_TEST_URL="+f.server.URL)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}
