package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
	"voices/internal/providers"
	"voices/internal/storage"
)

func (a *App) prepare(ctx context.Context, j job) error {
	var blob string
	if err := a.DB.QueryRow(ctx, "SELECT blob_id FROM media_assets WHERE recording_id=$1 AND kind='original'", j.RecordingID).Scan(&blob); err != nil {
		return err
	}
	dir, err := os.MkdirTemp(a.Config.TempDir, "voices-prepare-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	input := filepath.Join(dir, "original")
	output := filepath.Join(dir, "playback.mp3")
	reader, err := a.Blobs.Open(ctx, j.RecordingID, blob)
	if err != nil {
		return err
	}
	file, err := os.Create(input)
	if err != nil {
		reader.Close()
		return err
	}
	_, err = io.Copy(file, reader)
	closeErr := file.Close()
	reader.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := transcode(ctx, input, output); err != nil {
		return err
	}
	f, err := os.Open(output)
	if err != nil {
		return err
	}
	defer f.Close()
	writer, err := a.Blobs.NewWriter(ctx, j.RecordingID, &storage.JobFence{ID: j.ID, Owner: a.InstanceID, Generation: j.Generation})
	if err != nil {
		return err
	}
	defer writer.Close()
	if err := writer.WriteFrom(ctx, f, nil, a.Config.MaxUploadBytes); err != nil {
		return err
	}
	return persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if err := a.fence(ctx, tx, j); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM media_assets WHERE recording_id=$1 AND kind='playback')", j.RecordingID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			if err := writer.Publish(ctx, tx); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "INSERT INTO media_assets(id,recording_id,kind,blob_id) VALUES($1,$2,'playback',$3)", uuid.NewString(), j.RecordingID, writer.ID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, "UPDATE recordings SET state='ready',revision=revision+1 WHERE id=$1", j.RecordingID); err != nil {
			return err
		}
		var auto bool
		var raw []byte
		var duration, size int64
		if err := tx.QueryRow(ctx, "SELECT auto_transcribe,import_transcription_options,duration_ms,size_bytes FROM recordings WHERE id=$1", j.RecordingID).Scan(&auto, &raw, &duration, &size); err != nil {
			return err
		}
		if auto {
			var exists bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE dedupe_key=$1)", "auto:"+j.RecordingID).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				var o providers.Options
				if err := json.Unmarshal(raw, &o); err != nil {
					return err
				}
				model, err := a.validateOptions(o, duration, size)
				if err != nil {
					return err
				}
				if _, _, err := a.insertTranscription(ctx, tx, j.RecordingID, o, model, "auto:"+j.RecordingID); err != nil {
					return err
				}
			}
		}
		_, err := tx.Exec(ctx, "UPDATE jobs SET state='succeeded',stage='ready',lease_owner=NULL,lease_until=NULL,error_code=NULL WHERE id=$1", j.ID)
		return err
	})
}
func (a *App) transcribe(ctx context.Context, j job) error {
	if j.TranscriptionID == nil {
		return errors.New("transcription missing")
	}
	var optionsRaw []byte
	var provider string
	var originalName string
	var duration int64
	if err := a.DB.QueryRow(ctx, "SELECT t.provider,t.options_json,r.original_name,r.duration_ms FROM transcriptions t JOIN recordings r ON r.id=t.recording_id WHERE t.id=$1", *j.TranscriptionID).Scan(&provider, &optionsRaw, &originalName, &duration); err != nil {
		return err
	}
	p, ok := a.Providers[provider]
	if !ok {
		return &providers.Error{Code: "unsupported", Definitive: true}
	}
	var options providers.Options
	if err := json.Unmarshal(optionsRaw, &options); err != nil {
		return err
	}
	// Any abandoned sent request is unsafe even if the job stage was not advanced.
	var uncertain bool
	if err := a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM provider_operations WHERE job_id=$1 AND state IN ('sent','uncertain') AND remote_id IS NULL)", j.ID).Scan(&uncertain); err != nil {
		return err
	}
	if uncertain {
		_, err := a.DB.Exec(ctx, "UPDATE provider_operations SET state='uncertain' WHERE job_id=$1 AND state='sent' AND remote_id IS NULL", j.ID)
		if err != nil {
			return err
		}
		return &providers.Error{Code: "uncertain"}
	}
	remote, found, err := a.knownResource(ctx, j.ID, "submit")
	if err != nil {
		return err
	}
	if !found {
		file, uploaded, err := a.knownResource(ctx, j.ID, "upload")
		if err != nil {
			return err
		}
		if !uploaded {
			if err := a.stage(ctx, &j, "uploading"); err != nil {
				return err
			}
			var blob string
			if err := a.DB.QueryRow(ctx, "SELECT blob_id FROM media_assets WHERE recording_id=$1 AND kind='original'", j.RecordingID).Scan(&blob); err != nil {
				return err
			}
			reader, err := a.Blobs.Open(ctx, j.RecordingID, blob)
			if err != nil {
				return err
			}
			file, err = a.remoteCreate(ctx, j, provider, "upload", func(c context.Context) (providers.Resource, error) {
				return p.Upload(c, reader, originalName, reader.Size)
			})
			reader.Close()
			if err != nil {
				return err
			}
		}
		if err := a.stage(ctx, &j, "submitting"); err != nil {
			return err
		}
		remote, err = a.remoteCreate(ctx, j, provider, "submit", func(c context.Context) (providers.Resource, error) { return p.Submit(c, file, options) })
		if err != nil {
			return err
		}
	}
	if err := a.stage(ctx, &j, "polling"); err != nil {
		return err
	}
	for {
		stepCtx, cancel := context.WithTimeout(ctx, a.Config.HTTPTimeout)
		state, err := p.Poll(stepCtx, remote)
		cancel()
		if err != nil {
			return err
		}
		switch state.State {
		case "completed":
			goto completed
		case "failed":
			return &providers.Error{Code: "transcription_failed", Definitive: true}
		case "pending", "running":
			if err := pause(ctx, 2*time.Second); err != nil {
				return err
			}
		default:
			return &providers.Error{Code: "transient"}
		}
	}
completed:
	if err := a.stage(ctx, &j, "normalizing"); err != nil {
		return err
	}
	stepCtx, cancel := context.WithTimeout(ctx, a.Config.HTTPTimeout)
	result, err := p.FetchResult(stepCtx, remote)
	cancel()
	if err != nil {
		return err
	}
	// Reject invalid provider structure instead of inventing timings or silently truncating it.
	for _, s := range result.Segments {
		if (s.StartMS == nil) != (s.EndMS == nil) || s.StartMS != nil && (*s.StartMS < 0 || *s.EndMS < *s.StartMS || *s.EndMS > duration+1000) {
			return &providers.Error{Code: "invalid_result"}
		}
	}
	raw := result.Raw
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	writer, err := a.Blobs.NewWriter(ctx, j.RecordingID, &storage.JobFence{ID: j.ID, Owner: a.InstanceID, Generation: j.Generation})
	if err != nil {
		return err
	}
	defer writer.Close()
	if err := writer.WriteFrom(ctx, bytes.NewReader(raw), nil, 64<<20); err != nil {
		return err
	}
	return persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if err := a.fence(ctx, tx, j); err != nil {
			return err
		}
		if err := writer.Publish(ctx, tx); err != nil {
			return err
		}
		labels := map[string]string{}
		for i, s := range result.Segments {
			var label any
			if s.Speaker != nil {
				lid, ok := labels[*s.Speaker]
				if !ok {
					lid = uuid.NewString()
					labels[*s.Speaker] = lid
					if _, err := tx.Exec(ctx, "INSERT INTO speaker_labels(id,transcription_id,provider_label,display_name) VALUES($1,$2,$3,$4)", lid, *j.TranscriptionID, *s.Speaker, "说话人 "+*s.Speaker); err != nil {
						return err
					}
				}
				label = lid
			}
			if _, err := tx.Exec(ctx, "INSERT INTO segments(id,transcription_id,ordinal,start_ms,end_ms,source_text,source_speaker_label_id) VALUES($1,$2,$3,$4,$5,$6,$7)", uuid.NewString(), *j.TranscriptionID, i, s.StartMS, s.EndMS, s.Text, label); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, "UPDATE transcriptions SET state='succeeded',error_code=NULL,raw_response_blob_id=$2,revision=revision+1 WHERE id=$1", *j.TranscriptionID, writer.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE recordings SET active_transcription_id=$2,revision=revision+1 WHERE id=$1 AND active_transcription_id IS NULL", j.RecordingID, *j.TranscriptionID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "UPDATE jobs SET state='succeeded',stage='succeeded',error_code=NULL,lease_owner=NULL,lease_until=NULL WHERE id=$1", j.ID)
		return err
	})
}
func (a *App) knownResource(ctx context.Context, jobID, kind string) (providers.Resource, bool, error) {
	var id string
	err := a.DB.QueryRow(ctx, "SELECT remote_id FROM provider_operations WHERE job_id=$1 AND kind=$2 AND state='known' ORDER BY created_at DESC LIMIT 1", jobID, kind).Scan(&id)
	if err == pgx.ErrNoRows {
		return providers.Resource{}, false, nil
	}
	if err != nil {
		return providers.Resource{}, false, err
	}
	resourceKind := "file"
	if kind == "submit" {
		resourceKind = "transcription"
	}
	return providers.Resource{ID: id, Kind: resourceKind}, true, nil
}
func (a *App) remoteCreate(ctx context.Context, j job, provider, kind string, call func(context.Context) (providers.Resource, error)) (providers.Resource, error) {
	op := uuid.NewString()
	err := persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if err := a.fence(ctx, tx, j); err != nil {
			return err
		}
		var old string
		err := tx.QueryRow(ctx, "SELECT id FROM provider_operations WHERE job_id=$1 AND kind=$2 AND state='prepared' ORDER BY created_at DESC LIMIT 1 FOR UPDATE", j.ID, kind).Scan(&old)
		if err == nil {
			op = old
			return nil
		}
		if err != pgx.ErrNoRows {
			return err
		}
		_, err = tx.Exec(ctx, "INSERT INTO provider_operations(id,job_id,transcription_id,kind,lease_generation,state) VALUES($1,$2,$3,$4,$5,'prepared')", op, j.ID, *j.TranscriptionID, kind, j.Generation)
		return err
	})
	if err != nil {
		return providers.Resource{}, err
	}
	err = persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if err := a.fence(ctx, tx, j); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, "UPDATE provider_operations SET state='sent',lease_generation=$2 WHERE id=$1 AND state='prepared'", op, j.Generation)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return storage.ErrLease
		}
		return nil
	})
	if err != nil {
		return providers.Resource{}, err
	}
	deadline := a.Config.HTTPTimeout
	if kind == "upload" {
		deadline = 30 * time.Minute
	}
	stepCtx, cancel := context.WithTimeout(ctx, deadline)
	resource, remoteErr := call(stepCtx)
	cancel()
	// Late successful responses must be registered even after lease loss or shutdown.
	saveCtx, saveCancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer saveCancel()
	if remoteErr == nil {
		err = persistence.Transaction(saveCtx, a.DB, func(tx pgx.Tx) error { return registerResourceTx(saveCtx, tx, op, provider, resource) })
		if err != nil {
			return providers.Resource{}, &providers.Error{Code: "uncertain", Reason: "local_persistence"}
		}
		return resource, nil
	}
	var pe *providers.Error
	if errors.As(remoteErr, &pe) && pe.Definitive {
		_, err = a.DB.Exec(saveCtx, "UPDATE provider_operations SET state='confirmed_absent',terminal_evidence=$2 WHERE id=$1 AND state IN ('sent','uncertain') AND remote_id IS NULL", op, jsonBytes(map[string]string{"type": "adapter_terminal_rejection", "operation_id": op, "reason": pe.Code}))
		if err != nil {
			return providers.Resource{}, &providers.Error{Code: "uncertain", Reason: "local_persistence"}
		}
		return providers.Resource{}, remoteErr
	}
	_, _ = a.DB.Exec(saveCtx, "UPDATE provider_operations SET state='uncertain' WHERE id=$1 AND remote_id IS NULL AND state='sent'", op)
	result := &providers.Error{Code: "uncertain"}
	if pe != nil {
		result.Reason, result.HTTPStatus = pe.Reason, pe.HTTPStatus
	}
	return providers.Resource{}, result
}
func registerResourceTx(ctx context.Context, tx pgx.Tx, op, provider string, resource providers.Resource) error {
	var tid, kind, state, actualProvider string
	var old *string
	if err := tx.QueryRow(ctx, "SELECT o.transcription_id,o.kind,o.state,o.remote_id,t.provider FROM provider_operations o JOIN transcriptions t ON t.id=o.transcription_id WHERE o.id=$1 FOR UPDATE OF o", op).Scan(&tid, &kind, &state, &old, &actualProvider); err != nil {
		return err
	}
	expected := "file"
	if kind == "submit" {
		expected = "transcription"
	}
	if provider != actualProvider || resource.Kind != expected || resource.ID == "" || state == "confirmed_absent" || state == "prepared" {
		return conflict()
	}
	if old != nil && *old != resource.ID {
		return conflict()
	}
	// A resource cannot be attached to two different local transcriptions.
	var owner string
	err := tx.QueryRow(ctx, "SELECT transcription_id FROM provider_resources WHERE provider=$1 AND kind=$2 AND remote_id=$3", provider, resource.Kind, resource.ID).Scan(&owner)
	if err == nil && owner != tid {
		return conflict()
	}
	if err != nil && err != pgx.ErrNoRows {
		return err
	}
	if err := tx.QueryRow(ctx, "INSERT INTO provider_resources(id,transcription_id,provider,kind,remote_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider,kind,remote_id) DO UPDATE SET remote_id=excluded.remote_id WHERE provider_resources.transcription_id=excluded.transcription_id RETURNING transcription_id", uuid.NewString(), tid, provider, resource.Kind, resource.ID).Scan(&owner); err != nil {
		if err == pgx.ErrNoRows {
			return conflict()
		}
		return err
	}
	_, err = tx.Exec(ctx, "UPDATE provider_operations SET remote_id=$2,state='known' WHERE id=$1", op, resource.ID)
	return err
}
