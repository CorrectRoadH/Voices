// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
// @concord-implements docs/feature/transcription/use-case/recover-task.md
package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"voices/internal/outbound"
	"voices/internal/persistence"
	"voices/internal/providers"
	"voices/internal/storage"
)

// This predicate is shared by the Job view and the new-version authorization.
const duplicateRiskSQL = `(j.state IN ('uncertain','restore_hold') OR (j.state<>'succeeded' AND EXISTS(SELECT 1 FROM transcriptions dt WHERE dt.id=j.transcription_id AND dt.provider='openai') AND (j.direct_request_started_at IS NOT NULL OR COALESCE(j.error_code='direct_request_interrupted',false))))`

func (a *App) transcribeDirect(ctx context.Context, j job, adapter providers.DirectAdapter, name string, duration int64, options providers.Options) error {
	var blocked bool
	if err := a.DB.QueryRow(ctx, "SELECT direct_request_started_at IS NOT NULL OR COALESCE(error_code='direct_request_interrupted',false) FROM jobs WHERE id=$1", j.ID).Scan(&blocked); err != nil {
		return err
	}
	if blocked {
		return &providers.Error{Code: "direct_request_interrupted"}
	}
	var blob string
	if err := a.DB.QueryRow(ctx, "SELECT blob_id FROM media_assets WHERE recording_id=$1 AND kind='original'", j.RecordingID).Scan(&blob); err != nil {
		return err
	}
	reader, err := a.Blobs.Open(ctx, j.RecordingID, blob)
	if err != nil {
		return err
	}
	defer reader.Close()
	if _, err := a.validateOptions(options, duration, reader.Size); err != nil {
		return err
	}
	if adapter.ID() == "openai" && !providers.ValidOpenAIFilename(name) {
		return &providers.Error{Code: "direct_unsupported_format", Definitive: true}
	}
	const deadline = 30 * time.Minute
	var callID string
	err = persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if err := a.fence(ctx, tx, j); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE jobs SET direct_request_started_at=clock_timestamp(),stage='submitting' WHERE id=$1 AND direct_request_started_at IS NULL AND COALESCE(error_code,'')<>'direct_request_interrupted'`, j.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return &providers.Error{Code: "direct_request_interrupted"}
		}
		if _, err := tx.Exec(ctx, "UPDATE transcriptions SET state='submitting',error_code=NULL,revision=revision+1 WHERE id=$1", *j.TranscriptionID); err != nil {
			return err
		}
		c, err := a.transcriptionCall(ctx, tx, *j.TranscriptionID, "transcribe")
		if err != nil {
			return err
		}
		callID, err = startCall(ctx, tx, c, deadline)
		return err
	})
	// A commit error is never resolved by reading back the permission: only an
	// unambiguously committed transaction gives this invocation permission to send.
	if err != nil {
		return err
	}
	stepCtx, cancel := context.WithTimeout(ctx, deadline)
	stepCtx, observation := outbound.WithObservation(stepCtx)
	started := time.Now()
	result, remoteErr := adapter.Transcribe(stepCtx, reader, name, reader.Size, options)
	a.finishCall(ctx, callID, started, observation, remoteErr)
	cancel()
	reader.Close()
	if remoteErr != nil {
		return directFailure(remoteErr)
	}
	if err := a.stage(ctx, &j, "normalizing"); err != nil {
		return directFailure(err)
	}
	return directFailure(a.publishTranscription(ctx, j, result, duration))
}

func directFailure(err error) error {
	if err == nil || errors.Is(err, storage.ErrLease) {
		return err
	}
	var pe *providers.Error
	if errors.As(err, &pe) {
		copy := *pe
		if !strings.HasPrefix(copy.Code, "direct_") {
			copy.Code = "direct_" + copy.Code
		}
		return &copy
	}
	return &providers.Error{Code: "direct_result_persistence_failed", Reason: "local_persistence"}
}

// restoreDirectIntents consumes automatic OpenAI import intents even when the
// snapshot predates prepare creating a transcription. Called under Restore's lock.
func (a *App) restoreDirectIntents(ctx context.Context, tx pgx.Tx) error {
	rows, err := tx.Query(ctx, `SELECT r.id,r.import_transcription_options FROM recordings r WHERE r.state<>'deleting' AND r.auto_transcribe AND r.import_transcription_options->>'provider'='openai' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.dedupe_key='auto:'||r.id::text) ORDER BY r.id FOR UPDATE OF r`)
	if err != nil {
		return err
	}
	type intent struct {
		id  string
		raw []byte
	}
	var intents []intent
	for rows.Next() {
		var in intent
		if err := rows.Scan(&in.id, &in.raw); err != nil {
			rows.Close()
			return err
		}
		intents = append(intents, in)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, in := range intents {
		var options providers.Options
		if err := json.Unmarshal(in.raw, &options); err != nil {
			return err
		}
		model := providers.NewOpenAI("", "").Models()[0]
		if _, _, err := a.insertTranscription(ctx, tx, in.id, options, model, "auto:"+in.id); err != nil {
			return err
		}
	}
	// Lock recordings before jobs, matching publish/cancel. Configuration and
	// current adapter registration must never decide whether an old job is safe.
	if _, err := tx.Exec(ctx, `SELECT r.id FROM recordings r WHERE EXISTS(SELECT 1 FROM jobs j JOIN transcriptions t ON t.id=j.transcription_id WHERE j.recording_id=r.id AND j.kind='transcribe' AND j.state<>'succeeded' AND t.provider='openai') ORDER BY r.id FOR UPDATE OF r`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE jobs j SET state='failed',error_code='direct_request_interrupted',error_detail=NULL,lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1 WHERE j.kind='transcribe' AND j.state<>'succeeded' AND EXISTS(SELECT 1 FROM transcriptions t WHERE t.id=j.transcription_id AND t.provider='openai')`); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE transcriptions t SET state='failed',error_code='direct_request_interrupted',revision=revision+1 WHERE t.provider='openai' AND EXISTS(SELECT 1 FROM jobs j WHERE j.transcription_id=t.id AND j.error_code='direct_request_interrupted' AND j.state='failed')`)
	return err
}
