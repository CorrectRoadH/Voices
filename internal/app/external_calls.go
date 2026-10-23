// @concord-file
// @concord-implements docs/feature/call-logs/README.md
// @concord-implements docs/feature/call-logs/use-case/inspect-calls.md
package app

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"voices/internal/insights"
	"voices/internal/outbound"
	"voices/internal/providers"
)

type callDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}
type callStart struct {
	ID, Owner, Category, Operation, Provider, Model        string
	Recording, Transcription, Job, OperationID, Generation string
	AudioDuration                                          *int64
}

func (a *App) transcriptionCall(ctx context.Context, db callDB, tid, operation string) (callStart, error) {
	c := callStart{Category: "stt", Operation: operation, Transcription: tid}
	err := db.QueryRow(ctx, `SELECT r.owner_id,r.id,t.provider,t.model,r.duration_ms,COALESCE((SELECT j.id::text FROM jobs j WHERE j.transcription_id=t.id AND j.kind='transcribe' ORDER BY j.created_at DESC LIMIT 1),'') FROM transcriptions t JOIN recordings r ON r.id=t.recording_id WHERE t.id=$1`, tid).Scan(&c.Owner, &c.Recording, &c.Provider, &c.Model, &c.AudioDuration, &c.Job)
	return c, err
}
func startCall(ctx context.Context, db callDB, c callStart, timeout time.Duration) (string, error) {
	id := uuid.NewString()
	deadline := time.Now().Add(timeout + 30*time.Second)
	if d, ok := ctx.Deadline(); ok && d.Add(30*time.Second).Before(deadline) {
		deadline = d.Add(30 * time.Second)
	}
	_, err := db.Exec(ctx, `INSERT INTO external_calls(id,owner_id,category,operation,provider,model,recording_id,transcription_id,job_id,operation_id,generation,deadline_at,state,audio_duration_ms) VALUES($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,'')::uuid,NULLIF($8,'')::uuid,NULLIF($9,'')::uuid,NULLIF($10,'')::uuid,NULLIF($11,'')::uuid,$12,'running',$13)`, id, c.Owner, c.Category, c.Operation, c.Provider, c.Model, c.Recording, c.Transcription, c.Job, c.OperationID, c.Generation, deadline, c.AudioDuration)
	return id, err
}
func callOutcome(err error, m outbound.Metadata) (string, any, any) {
	if err == nil {
		return "succeeded", nil, nil
	}
	state, code, reason := "failed", "internal_error", "unspecified"
	var pe *providers.Error
	if errors.As(err, &pe) {
		switch pe.Code {
		case "auth", "invalid", "rate_limited", "transient", "uncertain", "unsupported", "not_found", "transcription_failed", "invalid_result":
			code = pe.Code
		}
		if code == "uncertain" {
			state = "uncertain"
		}
		if d := pe.Diagnostic(); d != nil {
			reason = d.Reason
		}
	} else {
		var ie insights.Error
		if errors.As(err, &ie) {
			switch string(ie) {
			case "invalid_response", "interrupted", "llm_rejected", "llm_unavailable", "configuration_changed", "model_list_timeout", "model_list_unauthorized", "model_list_unsupported", "model_list_invalid", "model_list_too_large", "model_list_unavailable":
				code = string(ie)
			}
			reason = insights.FailureReason(err)
			if m.RequestStarted && (code == "llm_unavailable" || code == "interrupted") {
				state = "uncertain"
			}
		}
	}
	return state, code, reason
}
func (a *App) finishCall(ctx context.Context, id string, started time.Time, observation *outbound.Observation, cause error) {
	m := observation.Snapshot()
	state, code, reason := callOutcome(cause, m)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	_, err := a.DB.Exec(ctx, `UPDATE external_calls SET state=$2,finished_at=clock_timestamp(),duration_ms=$3,request_started=$4,http_status=$5,input_tokens=$6,output_tokens=$7,total_tokens=$8,error_code=$9,error_reason=$10 WHERE id=$1 AND state IN ('running','interrupted') AND finished_at IS NULL`, id, state, max(0, time.Since(started).Milliseconds()), m.RequestStarted, m.HTTPStatus, m.InputTokens, m.OutputTokens, m.TotalTokens, code, reason)
	if err != nil {
		slog.Warn("call result persistence failed", "call_id", id, "error_type", errorType(err))
	}
}
func observedSTT[T any](ctx context.Context, a *App, tid, operation string, call func(context.Context) (T, error)) (T, error) {
	var zero T
	c, err := a.transcriptionCall(ctx, a.DB, tid, operation)
	if err != nil {
		return zero, err
	}
	id, err := startCall(ctx, a.DB, c, a.Config.HTTPTimeout)
	if err != nil {
		return zero, err
	}
	ctx, o := outbound.WithObservation(ctx)
	started := time.Now()
	result, err := call(ctx)
	a.finishCall(ctx, id, started, o, err)
	return result, err
}
func (a *App) pruneCalls(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	_, err := a.DB.Exec(ctx, `UPDATE external_calls SET state='interrupted',error_code='interrupted' WHERE id IN (SELECT id FROM external_calls WHERE state='running' AND deadline_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)`)
	if err != nil {
		return err
	}
	_, err = a.DB.Exec(ctx, `DELETE FROM external_calls WHERE id IN (SELECT id FROM external_calls WHERE started_at<clock_timestamp()-interval '30 days' ORDER BY started_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`)
	return err
}
