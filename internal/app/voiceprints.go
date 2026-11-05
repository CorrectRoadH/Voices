// @concord-file
// @concord-implements docs/feature/people/use-case/recognize-speaker.md
package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
	"voices/internal/voiceprints"
)

// The lock order is recording -> account -> child rows. All reference-changing
// writers use this account lock; matching reads references only after taking it.
func lockVoiceprintOwner(ctx context.Context, tx pgx.Tx, owner string) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "voiceprints:"+owner)
	return err
}
func voiceprintOwner(ctx context.Context, tx pgx.Tx, tid string) error {
	var owner string
	if err := tx.QueryRow(ctx, "SELECT owner_id FROM transcriptions WHERE id=$1", tid).Scan(&owner); err != nil {
		return err
	}
	return lockVoiceprintOwner(ctx, tx, owner)
}
func queueVoiceprints(ctx context.Context, tx pgx.Tx, tid string, invalidate bool) error {
	if invalidate {
		if _, err := tx.Exec(ctx, "DELETE FROM speaker_voiceprints WHERE label_id IN (SELECT id FROM speaker_labels WHERE transcription_id=$1)", tid); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `INSERT INTO voiceprint_tasks(transcription_id,generation,state) VALUES($1,$2,'queued')
 ON CONFLICT(transcription_id) DO UPDATE SET generation=EXCLUDED.generation,state='queued',lease_until=NULL,error_code=NULL,updated_at=clock_timestamp()
 WHERE $3 OR voiceprint_tasks.state NOT IN ('queued','running')`, tid, uuid.NewString(), invalidate)
	return err
}

type voiceprintWork struct{ TID, RID, Owner, Generation, RunID string }

func (a *App) claimVoiceprints(ctx context.Context) (voiceprintWork, error) {
	w := voiceprintWork{}
	if a.Config.RestoreMode {
		return w, pgx.ErrNoRows
	}
	err := persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		// The independent slot survives task invalidation and cascading deletion.
		var free bool
		if err := tx.QueryRow(ctx, "SELECT lease_until IS NULL OR lease_until<=clock_timestamp() FROM voiceprint_execution WHERE id FOR UPDATE SKIP LOCKED").Scan(&free); err != nil {
			return err
		}
		if !free {
			return pgx.ErrNoRows
		}
		if err := tx.QueryRow(ctx, `SELECT v.transcription_id,t.recording_id,t.owner_id FROM voiceprint_tasks v JOIN transcriptions t ON t.id=v.transcription_id JOIN recordings r ON r.id=t.recording_id WHERE t.state='succeeded' AND r.state='ready' AND (v.state='queued' OR v.state='running' AND v.lease_until<=clock_timestamp()) ORDER BY EXISTS(SELECT 1 FROM speaker_labels l JOIN people p ON p.id=l.person_id WHERE l.transcription_id=t.id AND l.identity_source='manual' AND p.builtin_key IS NULL AND p.archived_at IS NULL) DESC,v.updated_at,v.transcription_id LIMIT 1 FOR UPDATE OF v SKIP LOCKED`).Scan(&w.TID, &w.RID, &w.Owner); err != nil {
			return err
		}
		w.Generation = uuid.NewString()
		w.RunID = uuid.NewString()
		if _, err := tx.Exec(ctx, "UPDATE voiceprint_tasks SET state='running',generation=$2,lease_until=clock_timestamp()+interval '16 minutes',updated_at=clock_timestamp() WHERE transcription_id=$1", w.TID, w.Generation); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "UPDATE voiceprint_execution SET run_id=$1,lease_until=clock_timestamp()+interval '16 minutes' WHERE id", w.RunID)
		return err
	})
	return w, err
}
func (a *App) voiceprintCurrent(ctx context.Context, w voiceprintWork) error {
	var ok bool
	err := a.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM voiceprint_tasks v JOIN transcriptions t ON t.id=v.transcription_id JOIN recordings r ON r.id=t.recording_id CROSS JOIN voiceprint_execution e WHERE v.transcription_id=$1 AND v.generation=$2 AND v.state='running' AND v.lease_until>clock_timestamp() AND r.state='ready' AND e.run_id=$3 AND e.lease_until>clock_timestamp())`, w.TID, w.Generation, w.RunID).Scan(&ok)
	if err != nil {
		return err
	}
	if !ok {
		return context.Canceled
	}
	return nil
}
func (a *App) executeVoiceprints(parent context.Context, w voiceprintWork) {
	ctx, cancel := context.WithTimeout(parent, 15*time.Minute)
	defer cancel()
	defer func() {
		cleanup, stop := context.WithTimeout(context.WithoutCancel(parent), 5*time.Second)
		defer stop()
		if _, err := a.DB.Exec(cleanup, "UPDATE voiceprint_execution SET run_id=NULL,lease_until=NULL WHERE id AND run_id=$1", w.RunID); err != nil {
			a.recordRuntime(cleanup, "voiceprint_cleanup_failed", "database", "", "", 0, "")
		}
	}()
	err := a.processVoiceprints(ctx, w)
	if err == nil {
		return
	}
	cleanup, stop := context.WithTimeout(context.WithoutCancel(parent), 5*time.Second)
	defer stop()
	code := "processing_failed"
	switch err.Error() {
	case "inference_unavailable", "invalid_embedding", "model_mismatch", "too_many_segments", "too_many_speakers", "too_many_references":
		code = err.Error()
	}
	if ctx.Err() != nil {
		code = "interrupted"
	}
	state := "failed"
	if parent.Err() != nil {
		state = "queued"
	}
	_, writeErr := a.DB.Exec(cleanup, "UPDATE voiceprint_tasks SET state=$4,error_code=$3,lease_until=NULL,updated_at=clock_timestamp() WHERE transcription_id=$1 AND generation=$2 AND state='running'", w.TID, w.Generation, code, state)
	if writeErr != nil {
		a.recordRuntime(cleanup, "voiceprint_failure_persistence_failed", "database", "", "", 0, "")
	}
}

type extractedVoiceprint struct {
	Label  string
	Vector []float64
	MS     int64
	Count  int
}

func (a *App) processVoiceprints(ctx context.Context, w voiceprintWork) error {
	var segments []voiceprints.Segment
	var blob string
	var duration int64
	labels := []string{}
	err := persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if err := lockTranscription(ctx, tx, w.TID); err != nil {
			return err
		}
		var current bool
		if err := tx.QueryRow(ctx, "SELECT generation=$2 AND state='running' AND lease_until>clock_timestamp() FROM voiceprint_tasks WHERE transcription_id=$1", w.TID, w.Generation).Scan(&current); err != nil {
			return err
		}
		if !current {
			return context.Canceled
		}
		if err := tx.QueryRow(ctx, "SELECT m.blob_id,r.duration_ms FROM media_assets m JOIN recordings r ON r.id=m.recording_id WHERE m.recording_id=$1 AND m.kind='original'", w.RID).Scan(&blob, &duration); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, "SELECT l.id FROM speaker_labels l LEFT JOIN people p ON p.id=l.person_id WHERE l.transcription_id=$1 AND p.builtin_key IS NULL AND p.archived_at IS NULL ORDER BY l.id LIMIT 129", w.TID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			labels = append(labels, id)
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			return err
		}
		if len(labels) > 128 {
			return errors.New("too_many_speakers")
		}
		rows, err = tx.Query(ctx, "SELECT COALESCE(source_speaker_label_id::text,''),assignment_mode,start_ms,end_ms FROM segments WHERE transcription_id=$1 ORDER BY ordinal LIMIT 20001", w.TID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var s voiceprints.Segment
			if err := rows.Scan(&s.Label, &s.Mode, &s.Start, &s.End); err != nil {
				return err
			}
			segments = append(segments, s)
		}
		if len(segments) > 20000 {
			return errors.New("too_many_segments")
		}
		return rows.Err()
	})
	if err != nil {
		return err
	}
	clips := map[string][]voiceprints.Clip{}
	for _, label := range labels {
		if c := voiceprints.Clips(segments, label, duration); len(c) > 0 {
			clips[label] = c
		}
	}
	results := []extractedVoiceprint{}
	if len(clips) > 0 {
		dir, err := os.MkdirTemp(a.Config.TempDir, "voices-voiceprints-*")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		path := filepath.Join(dir, "original")
		// Open outside the snapshot transaction: storage acquires its own recording lock.
		reader, err := a.Blobs.Open(ctx, w.RID, blob)
		if err != nil {
			return err
		}
		f, err := os.Create(path)
		if err != nil {
			reader.Close()
			return err
		}
		_, copyErr := io.Copy(f, reader)
		closeErr := f.Close()
		reader.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		for _, label := range labels {
			blocks := clips[label]
			if len(blocks) == 0 {
				continue
			}
			vectors := [][]float64{}
			ms := int64(0)
			for _, clip := range blocks {
				if err := a.voiceprintCurrent(ctx, w); err != nil {
					return err
				}
				pcm, err := voiceprintPCM(ctx, path, clip)
				if err != nil {
					return err
				}
				vector, err := a.voiceprintEngine.Extract(ctx, pcm)
				if errors.Is(err, voiceprints.ErrAudio) {
					continue
				}
				if err != nil {
					return err
				}
				vectors = append(vectors, vector)
				ms += int64(len(pcm) / 32)
			}
			vector, err := voiceprints.Average(vectors, true)
			if err != nil || ms < 6000 {
				continue
			}
			results = append(results, extractedVoiceprint{label, vector, ms, len(vectors)})
		}
	}
	return a.publishVoiceprints(ctx, w, results)
}
func voiceprintPCM(ctx context.Context, path string, clip voiceprints.Clip) ([]byte, error) {
	step, stop := context.WithTimeout(ctx, 30*time.Second)
	defer stop()
	cmd := exec.CommandContext(step, "ffmpeg", "-nostdin", "-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-format_whitelist", mediaFormats, "-ss", fmt.Sprintf("%.3f", float64(clip.Start)/1000), "-i", path, "-t", fmt.Sprintf("%.3f", float64(clip.End-clip.Start)/1000), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-threads", "1", "-f", "s16le", "pipe:1")
	// ffmpeg duration is bounded; the writer additionally refuses oversized output.
	out := &boundedPCM{}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil {
		return nil, errors.New("audio_extraction_failed")
	}
	return out.Bytes(), nil
}

type boundedPCM struct{ bytes.Buffer }

func (b *boundedPCM) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 320000 {
		return 0, errors.New("audio_too_large")
	}
	return b.Buffer.Write(p)
}

func (a *App) publishVoiceprints(ctx context.Context, w voiceprintWork, results []extractedVoiceprint) error {
	return persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if err := lockTranscription(ctx, tx, w.TID); err != nil {
			return err
		}
		if err := lockVoiceprintOwner(ctx, tx, w.Owner); err != nil {
			return err
		}
		var valid bool
		if err := tx.QueryRow(ctx, "SELECT COALESCE(run_id=$1 AND lease_until>clock_timestamp(),false) FROM voiceprint_execution WHERE id FOR UPDATE", w.RunID).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return context.Canceled
		}
		if err := tx.QueryRow(ctx, `SELECT generation=$2 AND state='running' AND lease_until>clock_timestamp() FROM voiceprint_tasks WHERE transcription_id=$1 FOR UPDATE`, w.TID, w.Generation).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return context.Canceled
		}
		people := map[string][][]float64{}
		rows, err := tx.Query(ctx, `SELECT l.person_id,v.embedding FROM speaker_voiceprints v JOIN speaker_labels l ON l.id=v.label_id JOIN people p ON p.id=l.person_id JOIN transcriptions t ON t.id=l.transcription_id JOIN recordings r ON r.id=t.recording_id WHERE l.owner_id=$1 AND l.identity_source='manual' AND p.archived_at IS NULL AND p.builtin_key IS NULL AND r.state='ready' AND r.id<>$2 AND v.model=$3 ORDER BY l.id LIMIT 5001`, w.Owner, w.RID, voiceprints.Model)
		if err != nil {
			return err
		}
		count := 0
		for rows.Next() {
			var person string
			var v []float64
			if err = rows.Scan(&person, &v); err != nil {
				rows.Close()
				return err
			}
			people[person] = append(people[person], v)
			count++
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			return err
		}
		if count > 5000 {
			return errors.New("too_many_references")
		}
		if _, err = tx.Exec(ctx, "DELETE FROM speaker_voiceprints WHERE label_id IN (SELECT id FROM speaker_labels WHERE transcription_id=$1)", w.TID); err != nil {
			return err
		}
		for _, result := range results {
			if _, err = tx.Exec(ctx, `INSERT INTO speaker_voiceprints(label_id,model,embedding,sample_ms,sample_count) VALUES($1,$2,$3,$4,$5)`, result.Label, voiceprints.Model, result.Vector, result.MS, result.Count); err != nil {
				return err
			}
			person, score := voiceprints.Match(result.Vector, people)
			if person == "" {
				continue
			}
			if _, err = tx.Exec(ctx, "UPDATE speaker_labels SET person_id=$2,identity_source='automatic',match_score=$3,revision=revision+1 WHERE id=$1 AND identity_source='unassigned' AND person_id IS NULL", result.Label, person, score); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, "UPDATE voiceprint_tasks SET state='succeeded',error_code=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE transcription_id=$1 AND generation=$2", w.TID, w.Generation)
		return err
	})
}

func (a *App) getTranscriptionVoiceprints(w http.ResponseWriter, r *http.Request) error {
	var state string
	if err := a.DB.QueryRow(r.Context(), "SELECT t.state FROM transcriptions t JOIN recordings r ON r.id=t.recording_id WHERE t.id=$1 AND r.state<>'deleting'", r.PathValue("id")).Scan(&state); err != nil {
		return err
	}
	task, err := one(r.Context(), a.DB, "SELECT state,generation,error_code,updated_at FROM voiceprint_tasks WHERE transcription_id=$1", r.PathValue("id"))
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var samples int
	if err := a.DB.QueryRow(r.Context(), "SELECT count(*) FROM speaker_voiceprints v JOIN speaker_labels l ON l.id=v.label_id WHERE l.transcription_id=$1 AND v.model=$2", r.PathValue("id"), voiceprints.Model).Scan(&samples); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"configured": true, "task": task, "samples": samples})
	return nil
}
func (a *App) retryTranscriptionVoiceprints(w http.ResponseWriter, r *http.Request) error {
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		tid := r.PathValue("id")
		if err := lockTranscription(r.Context(), tx, tid); err != nil {
			return err
		}
		var state string
		if err := tx.QueryRow(r.Context(), "SELECT state FROM transcriptions WHERE id=$1", tid).Scan(&state); err != nil {
			return err
		}
		if state != "succeeded" {
			return &apiError{409, "not_completed", "版本尚未完成"}
		}
		return queueVoiceprints(r.Context(), tx, tid, false)
	})
	if err != nil {
		return err
	}
	return a.getTranscriptionVoiceprints(w, r)
}
func (a *App) getPersonVoiceprints(w http.ResponseWriter, r *http.Request) error {
	var samples int
	var ms int64
	err := a.DB.QueryRow(r.Context(), `SELECT count(*),COALESCE(sum(v.sample_ms),0) FROM speaker_voiceprints v JOIN speaker_labels l ON l.id=v.label_id JOIN people p ON p.id=l.person_id JOIN transcriptions t ON t.id=l.transcription_id JOIN recordings r ON r.id=t.recording_id WHERE p.id=$1 AND p.archived_at IS NULL AND p.builtin_key IS NULL AND l.identity_source='manual' AND r.state='ready' AND v.model=$2`, r.PathValue("id"), voiceprints.Model).Scan(&samples, &ms)
	if err != nil {
		return err
	}
	var pending int
	err = a.DB.QueryRow(r.Context(), `SELECT count(DISTINCT q.transcription_id) FROM voiceprint_tasks q JOIN speaker_labels l ON l.transcription_id=q.transcription_id WHERE l.person_id=$1 AND l.identity_source='manual' AND q.state IN ('queued','running')`, r.PathValue("id")).Scan(&pending)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"configured": true, "samples": samples, "sample_ms": ms, "pending": pending})
	return nil
}
func (a *App) rebuildPersonVoiceprints(w http.ResponseWriter, r *http.Request) error {
	// No recording locks are held: queuing does not change existing references and
	// cannot evict a physical execution slot. Fresh snapshots are taken by workers.
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		if err := lockVoiceprintOwner(r.Context(), tx, persistence.UserID(r.Context())); err != nil {
			return err
		}
		if err := assignablePerson(r.Context(), tx, r.PathValue("id")); err != nil {
			return err
		}
		var builtin *string
		if err := tx.QueryRow(r.Context(), "SELECT builtin_key FROM people WHERE id=$1", r.PathValue("id")).Scan(&builtin); err != nil {
			return err
		}
		if builtin != nil {
			return bad("builtin_person_readonly", "内置人物不可建立声纹")
		}
		_, err := tx.Exec(r.Context(), `INSERT INTO voiceprint_tasks(transcription_id,generation,state) SELECT DISTINCT t.id,gen_random_uuid(),'queued' FROM transcriptions t WHERE t.state='succeeded' AND EXISTS(SELECT 1 FROM speaker_labels l WHERE l.transcription_id=t.id AND l.person_id=$1 AND l.identity_source='manual') AND EXISTS(SELECT 1 FROM recordings r WHERE r.id=t.recording_id AND r.state='ready') ON CONFLICT(transcription_id) DO UPDATE SET generation=EXCLUDED.generation,state='queued',lease_until=NULL,error_code=NULL,updated_at=clock_timestamp() WHERE voiceprint_tasks.state NOT IN ('queued','running')`, r.PathValue("id"))
		return err
	})
	if err != nil {
		return err
	}
	return a.getPersonVoiceprints(w, r)
}
