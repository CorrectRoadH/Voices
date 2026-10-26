package app

import (
	"context"
	"github.com/google/uuid"
	"os"
	"os/exec"
	"testing"
	"time"
)

// @feature docs/feature/appearance/README.md
func TestLoadingBrowser(t *testing.T) {
	if os.Getenv("VOICES_BROWSER_TEST") != "1" {
		t.Skip("set VOICES_BROWSER_TEST=1 after building web")
	}
	f, rid, tid, ids := referenceFixture(t)
	f.a.Config.WebDir = "../../web/dist"
	ctx := context.Background()
	owner := userID(t, f)
	var jobRecording, callRecording string
	for i := 0; i < 35; i++ {
		id := uuid.NewString()
		if i == 0 {
			jobRecording = id
		}
		if i == 1 {
			callRecording = id
		}
		_, err := f.db.Exec(ctx, `INSERT INTO recordings(id,owner_id,sha256,title,original_name,recorded_at,recorded_at_source,duration_ms,size_bytes,mime_type,state,auto_transcribe) VALUES($1,$2,$4,'加载验收 '||$3::int::text,'test.wav',now()-$3::int*interval '1 hour','import',1000,10,'audio/wav','ready',false)`, id, owner, i, id)
		if err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 55; i++ {
		id := uuid.NewString()
		_, err := f.db.Exec(ctx, `INSERT INTO jobs(id,recording_id,dedupe_key,kind,stage,state,created_at) VALUES($1,$2,$4,'prepare','prepare','queued',now()-$3::int*interval '1 second')`, id, jobRecording, i, id)
		if err != nil {
			t.Fatal(err)
		}
		callID := rid
		if i >= 50 {
			callID = callRecording
		}
		_, err = f.db.Exec(ctx, `INSERT INTO external_calls(id,owner_id,recording_id,category,operation,provider,model,deadline_at,state,request_started,http_status,started_at) VALUES($1,$2,$3,'stt','upload','soniox','loading-test',now(),'succeeded',true,200,now()-$4::int*interval '1 second')`, uuid.NewString(), owner, callID, i)
		if err != nil {
			t.Fatal(err)
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "vp", "exec", "e2e", "run", "tests/loading.e2e.ts")
	cmd.Dir = "../../web"
	cmd.Env = append(os.Environ(), "VOICES_TEST_URL="+f.server.URL, "VOICES_LOADING_RID="+rid, "VOICES_LOADING_TID="+tid, "VOICES_LOADING_TARGET="+ids[110], "VOICES_LOADING_JOB_RECORDING="+jobRecording, "VOICES_E2E_OUTPUT=.e2e/loading", "E2E_TELEMETRY_DISABLED=1")
	out, err := cmd.CombinedOutput()
	t.Log(string(out))
	if err != nil {
		t.Fatal(err)
	}
}
