package app

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
	"voices/internal/providers"
	"voices/internal/storage"
)

type job struct {
	ID, Kind, RecordingID, Stage string
	TranscriptionID              *string
	Generation                   int64
	Attempt                      int
}

func (a *App) Restore(ctx context.Context) error {
	if !a.Config.RestoreMode {
		return nil
	}
	return persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(771940002)"); err != nil {
			return err
		}
		for _, sql := range []string{
			"DELETE FROM blob_read_leases",
			"UPDATE external_calls SET state='interrupted',error_code='interrupted',error_reason='database_restore' WHERE state='running'",
			"UPDATE transcription_insights SET state='failed',error_code='interrupted',input_json=NULL,llm_config_json=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE state IN ('queued','running')",
			"UPDATE blobs SET write_generation=write_generation+1,write_lease_until=NULL,writer_id=NULL WHERE state='writing'",
			"UPDATE jobs SET lease_generation=lease_generation+1,lease_owner=NULL,lease_until=NULL,state=CASE WHEN kind='transcribe' THEN 'restore_hold' WHEN state IN ('running','retry_wait') THEN 'queued' ELSE state END,error_code=CASE WHEN kind='transcribe' THEN 'restore_hold' ELSE error_code END WHERE state<>'succeeded' OR EXISTS(SELECT 1 FROM provider_operations o WHERE o.job_id=jobs.id AND o.state IN ('prepared','sent','uncertain'))",
			"UPDATE transcriptions t SET state='restore_hold',error_code='restore_hold',revision=revision+1 WHERE EXISTS(SELECT 1 FROM jobs j WHERE j.transcription_id=t.id AND j.state='restore_hold')",
			"UPDATE provider_operations o SET state='uncertain' WHERE o.state IN ('prepared','sent') AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=o.job_id AND j.state='restore_hold')",
			`INSERT INTO provider_operations(id,job_id,transcription_id,kind,lease_generation,state,resolution_note) SELECT gen_random_uuid(),j.id,j.transcription_id,k.kind,j.lease_generation,'uncertain','数据库快照之后的远端状态须核对' FROM jobs j CROSS JOIN (VALUES ('upload'),('submit')) AS k(kind) WHERE j.state='restore_hold' AND NOT EXISTS(SELECT 1 FROM provider_operations o WHERE o.job_id=j.id AND o.kind=k.kind AND o.state IN ('known','uncertain','sent','prepared'))`,
		} {
			if _, err := tx.Exec(ctx, sql); err != nil {
				return err
			}
		}
		return nil
	})
}

// Run supervises durable jobs until shutdown; no application-local queue owns work.
func (a *App) Run(ctx context.Context) {
	var wg sync.WaitGroup
	defer wg.Wait()
	if a.runtimeCleaning.CompareAndSwap(false, true) {
		wg.Add(1)
		go func() { defer wg.Done(); a.runRuntimeCleanup(ctx) }()
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastCleanup := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if a.Config.RestoreMode {
				continue
			}
			if work, err := a.claimInsight(ctx); err == nil {
				wg.Add(1)
				go func() { defer wg.Done(); a.executeInsight(ctx, work) }()
			} else if err != pgx.ErrNoRows && ctx.Err() == nil {
				a.recordRuntime(ctx, "job_claim_failed", errorType(err), "", "", 0, "")
			}
			for _, kind := range []string{"prepare", "transcribe"} {
				j, err := a.claim(ctx, kind)
				if err != nil && err != pgx.ErrNoRows && ctx.Err() == nil {
					slog.Error("job claim failed", "kind", kind, "error_type", errorType(err))
					a.recordRuntime(ctx, "job_claim_failed", errorType(err), "", "", 0, "")
				}
				if err == nil {
					wg.Add(1)
					go func() { defer wg.Done(); a.execute(ctx, j) }()
				}
			}
			if time.Since(lastCleanup) > 10*time.Second {
				lastCleanup = time.Now()
				wg.Add(1)
				go func() {
					defer wg.Done()
					if err := a.maintenance(ctx); err != nil && ctx.Err() == nil {
						slog.Error("maintenance failed", "error_type", errorType(err))
						a.recordRuntime(ctx, "maintenance_failed", errorType(err), "", "", 0, "")
					}
				}()
			}
		}
	}
}
func (a *App) claim(ctx context.Context, kind string) (job, error) {
	j := job{}
	err := persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(771940003)"); err != nil {
			return err
		}
		limit := a.Config.TranscriptionConcurrency
		if kind == "prepare" {
			limit = a.Config.PrepareConcurrency
		}
		var count int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM jobs WHERE kind=$1 AND state='running' AND lease_until>clock_timestamp()", kind).Scan(&count); err != nil {
			return err
		}
		if count >= limit {
			return pgx.ErrNoRows
		}
		if err := tx.QueryRow(ctx, `SELECT j.id,j.recording_id FROM jobs j JOIN recordings r ON r.id=j.recording_id WHERE j.kind=$1 AND r.state<>'deleting' AND NOT j.cancel_requested AND ((j.state IN ('queued','retry_wait') AND j.next_run_at<=clock_timestamp()) OR (j.state='running' AND j.lease_until<=clock_timestamp())) ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, kind).Scan(&j.ID, &j.RecordingID); err != nil {
			return err
		}
		return tx.QueryRow(ctx, "UPDATE jobs SET state='running',lease_owner=$2,lease_generation=lease_generation+1,lease_until=clock_timestamp()+interval '45 seconds',updated_at=clock_timestamp() WHERE id=$1 AND NOT cancel_requested RETURNING kind,transcription_id,stage,lease_generation,attempt", j.ID, a.InstanceID).Scan(&j.Kind, &j.TranscriptionID, &j.Stage, &j.Generation, &j.Attempt)
	})
	return j, err
}
func (a *App) fence(ctx context.Context, tx pgx.Tx, j job) error {
	var state string
	if err := tx.QueryRow(ctx, "SELECT state FROM recordings WHERE id=$1 FOR UPDATE", j.RecordingID).Scan(&state); err != nil {
		return err
	}
	if state == "deleting" {
		return storage.ErrLease
	}
	var valid bool
	if err := tx.QueryRow(ctx, "SELECT state='running' AND lease_owner=$2::uuid AND lease_generation=$3 AND lease_until>clock_timestamp() AND NOT cancel_requested FROM jobs WHERE id=$1 FOR UPDATE", j.ID, a.InstanceID, j.Generation).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return storage.ErrLease
	}
	return nil
}
func (a *App) execute(parent context.Context, j job) {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				tag, err := a.DB.Exec(ctx, "UPDATE jobs SET lease_until=clock_timestamp()+interval '45 seconds' WHERE id=$1 AND lease_owner=$2 AND lease_generation=$3 AND lease_until>clock_timestamp() AND state='running' AND NOT cancel_requested", j.ID, a.InstanceID, j.Generation)
				if err != nil || tag.RowsAffected() != 1 {
					cancel()
					return
				}
			}
		}
	}()
	var err error
	if j.Kind == "prepare" {
		err = a.prepare(ctx, j)
	} else {
		err = a.transcribe(ctx, j)
	}
	if err != nil && !errors.Is(err, storage.ErrLease) && ctx.Err() == nil {
		if e := a.failJob(ctx, j, err); e != nil {
			slog.Error("job failure persistence failed", "job_id", j.ID, "error_type", errorType(e))
			a.recordRuntime(ctx, "job_failure_persistence_failed", errorType(e), "", "", 0, j.ID)
		}
	}
	cancel()
	<-done
}
func (a *App) stage(ctx context.Context, j *job, stage string) error {
	err := persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if err := a.fence(ctx, tx, *j); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE jobs SET stage=$2,error_code=NULL,error_detail=NULL WHERE id=$1", j.ID, stage); err != nil {
			return err
		}
		if j.TranscriptionID != nil {
			_, err := tx.Exec(ctx, "UPDATE transcriptions SET state=$2,error_code=NULL,revision=revision+1 WHERE id=$1", *j.TranscriptionID, stage)
			return err
		}
		return nil
	})
	if err == nil {
		j.Stage = stage
	}
	return err
}
func (a *App) failJob(ctx context.Context, j job, cause error) error {
	var detail *providers.Diagnostic
	code := "processing_failed"
	state := "failed"
	delay := time.Duration(min(60, 2<<min(j.Attempt, 5))) * time.Second
	var pe *providers.Error
	if errors.As(cause, &pe) {
		code = pe.Code
		detail = pe.Diagnostic()
		if pe.Code == "uncertain" {
			state = "uncertain"
		} else if (pe.Code == "transient" || pe.Code == "rate_limited") && j.Attempt < 7 {
			state = "retry_wait"
		}
		if pe.RetryAfterSeconds > 0 {
			delay = max(delay, time.Duration(pe.RetryAfterSeconds)*time.Second)
		}
	}
	err := persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if err := a.fence(ctx, tx, j); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE jobs SET state=$2,error_code=$3,error_detail=$5,attempt=attempt+1,next_run_at=clock_timestamp()+$4::interval,lease_owner=NULL,lease_until=NULL WHERE id=$1", j.ID, state, code, delay.String(), detail); err != nil {
			return err
		}
		if j.TranscriptionID != nil {
			_, err := tx.Exec(ctx, "UPDATE transcriptions SET state=$2,error_code=$3,revision=revision+1 WHERE id=$1", *j.TranscriptionID, state, code)
			return err
		}
		_, err := tx.Exec(ctx, "UPDATE recordings SET state='failed',revision=revision+1 WHERE id=$1", j.RecordingID)
		return err
	})
	if err == nil {
		a.recordRuntime(ctx, "job_failed", code, "", "", 0, j.ID)
	}
	return err
}
func pause(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
