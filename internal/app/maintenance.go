package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
	"voices/internal/providers"
)

func (a *App) maintenance(ctx context.Context) error {
	conn, err := a.DB.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	var acquired bool
	if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(771940004)").Scan(&acquired); err != nil {
		return err
	}
	if !acquired {
		return nil
	}
	defer conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock(771940004)")
	if _, err := a.DB.Exec(ctx, "DELETE FROM blob_read_leases WHERE expires_at<clock_timestamp()"); err != nil {
		return err
	}
	if _, err := a.DB.Exec(ctx, "DELETE FROM sessions WHERE expires_at<clock_timestamp()"); err != nil {
		return err
	}
	if _, err := a.DB.Exec(ctx, "DELETE FROM rate_limit_buckets WHERE window_start<clock_timestamp()-interval '1 day'"); err != nil {
		return err
	}
	if err := a.cleanupRemote(ctx); err != nil {
		return err
	}
	if err := a.deleteOneRecording(ctx); err != nil {
		return err
	}
	return a.collectBlobs(ctx)
}
func (a *App) cleanupRemote(ctx context.Context) error {
	var id, tid, provider, kind, remote string
	err := persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT p.id,p.transcription_id,p.provider,p.kind,p.remote_id FROM provider_resources p JOIN transcriptions t ON t.id=p.transcription_id JOIN recordings r ON r.id=t.recording_id WHERE p.cleanup_state<>'deleted' AND (p.next_cleanup_at IS NULL OR p.next_cleanup_at<=clock_timestamp()) AND (t.state IN ('succeeded','cancelled') OR r.state='deleting') AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.transcription_id=t.id AND j.state='restore_hold') AND NOT EXISTS(SELECT 1 FROM provider_operations o WHERE o.transcription_id=t.id AND o.state IN ('sent','uncertain')) AND (p.kind='transcription' OR NOT EXISTS(SELECT 1 FROM provider_resources other WHERE other.transcription_id=p.transcription_id AND other.kind='transcription' AND other.cleanup_state<>'deleted')) ORDER BY CASE p.kind WHEN 'transcription' THEN 0 ELSE 1 END,p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`).Scan(&id, &tid, &provider, &kind, &remote)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, "UPDATE provider_resources SET cleanup_state='deleting',next_cleanup_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", id)
		return err
	})
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	p, ok := a.Providers[provider]
	if !ok {
		return nil
	}
	resource := providers.Resource{ID: remote, Kind: kind}
	stepCtx, cancel := context.WithTimeout(ctx, a.Config.HTTPTimeout)
	defer cancel()
	if kind == "transcription" {
		state, err := p.Poll(stepCtx, resource)
		if err == nil && (state.State == "pending" || state.State == "running") {
			_, err = a.DB.Exec(ctx, "UPDATE provider_resources SET cleanup_state='pending',next_cleanup_at=clock_timestamp()+interval '10 seconds' WHERE id=$1", id)
			return err
		}
		if err != nil {
			var pe *providers.Error
			if !errors.As(err, &pe) || pe.Code != "not_found" {
				return a.cleanupFailure(ctx, id, tid, err)
			}
		}
	}
	if err := p.DeleteResource(stepCtx, resource); err != nil {
		return a.cleanupFailure(ctx, id, tid, err)
	}
	return persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "UPDATE provider_resources SET cleanup_state='deleted',last_error=NULL,next_cleanup_at=NULL WHERE id=$1", id); err != nil {
			return err
		}
		// AssemblyAI's documented successful transcript DELETE also deletes the
		// associated uploaded audio. Only correlate the upload within that same job.
		if provider == "assemblyai" && kind == "transcription" {
			if _, err := tx.Exec(ctx, `UPDATE provider_resources f SET cleanup_state='deleted',last_error=NULL,next_cleanup_at=NULL WHERE f.provider='assemblyai' AND f.kind='file' AND f.transcription_id=$1 AND EXISTS(SELECT 1 FROM provider_operations upload JOIN provider_operations submit ON submit.job_id=upload.job_id WHERE upload.transcription_id=$1 AND upload.kind='upload' AND upload.remote_id=f.remote_id AND upload.state='known' AND submit.kind='submit' AND submit.state='known' AND submit.remote_id=$2)`, tid, remote); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, "UPDATE jobs SET error_code=NULL WHERE transcription_id=$1 AND state='succeeded' AND NOT EXISTS(SELECT 1 FROM provider_resources WHERE transcription_id=$1 AND cleanup_state='failed')", tid)
		return err
	})
}
func (a *App) cleanupFailure(ctx context.Context, id, tid string, cause error) error {
	code := "cleanup_failed"
	var pe *providers.Error
	if errors.As(cause, &pe) {
		code = "cleanup_" + pe.Code
	}
	_, err := a.DB.Exec(ctx, "UPDATE provider_resources SET cleanup_state='failed',last_error=$2,next_cleanup_at=clock_timestamp()+interval '1 hour' WHERE id=$1", id, code)
	if err != nil {
		return err
	}
	_, err = a.DB.Exec(ctx, "UPDATE jobs SET error_code=$2 WHERE transcription_id=$1 AND state IN ('succeeded','cancelled')", tid, code)
	return err
}
func (a *App) deleteOneRecording(ctx context.Context) error {
	return persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		var rid string
		err := tx.QueryRow(ctx, `SELECT r.id FROM recordings r WHERE r.state='deleting'
 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.recording_id=r.id AND j.state='restore_hold')
 AND NOT EXISTS(SELECT 1 FROM provider_operations o JOIN jobs j ON j.id=o.job_id WHERE j.recording_id=r.id AND o.state IN ('sent','uncertain'))
 AND NOT EXISTS(SELECT 1 FROM provider_resources p JOIN transcriptions t ON t.id=p.transcription_id WHERE t.recording_id=r.id AND p.cleanup_state<>'deleted')
 AND NOT EXISTS(SELECT 1 FROM blob_read_leases l WHERE l.expires_at>clock_timestamp() AND l.blob_id IN (SELECT blob_id FROM media_assets WHERE recording_id=r.id UNION SELECT raw_response_blob_id FROM transcriptions WHERE recording_id=r.id))
 ORDER BY r.deleted_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED`).Scan(&rid)
		if err == pgx.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, "SELECT id FROM jobs WHERE recording_id=$1 ORDER BY id FOR UPDATE", rid)
		if err != nil {
			return err
		}
		rows.Close()
		var held bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE recording_id=$1 AND state='restore_hold')", rid).Scan(&held); err != nil {
			return err
		}
		if held {
			return nil
		}
		// Deletion fenced the executor before these prepared intents are terminated.
		if _, err := tx.Exec(ctx, `UPDATE provider_operations SET state='confirmed_absent',terminal_evidence=jsonb_build_object('type','prepared_cancelled','operation_id',id) WHERE job_id IN (SELECT id FROM jobs WHERE recording_id=$1) AND state='prepared'`, rid); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM provider_operations o JOIN jobs j ON j.id=o.job_id WHERE j.recording_id=$1 AND o.state IN ('sent','uncertain')) OR EXISTS(SELECT 1 FROM provider_resources p JOIN transcriptions t ON t.id=p.transcription_id WHERE t.recording_id=$1 AND p.cleanup_state<>'deleted')`, rid).Scan(&held); err != nil {
			return err
		}
		if held {
			return nil
		}
		blobs, err := tx.Query(ctx, `SELECT id FROM blobs WHERE id IN (SELECT blob_id FROM media_assets WHERE recording_id=$1 UNION SELECT raw_response_blob_id FROM transcriptions WHERE recording_id=$1) ORDER BY id FOR UPDATE`, rid)
		if err != nil {
			return err
		}
		ids := []string{}
		for blobs.Next() {
			var id string
			if err := blobs.Scan(&id); err != nil {
				blobs.Close()
				return err
			}
			ids = append(ids, id)
		}
		blobs.Close()
		if err := blobs.Err(); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM blob_read_leases WHERE blob_id=ANY($1::uuid[]) AND expires_at>clock_timestamp())", ids).Scan(&held); err != nil {
			return err
		}
		if held {
			return nil
		}
		for _, sql := range []string{
			"DELETE FROM idempotency_keys WHERE resource_id=$1 OR resource_id IN (SELECT id FROM transcriptions WHERE recording_id=$1) OR resource_id IN (SELECT l.id FROM speaker_labels l JOIN transcriptions t ON t.id=l.transcription_id WHERE t.recording_id=$1)",
			"DELETE FROM provider_resources WHERE transcription_id IN (SELECT id FROM transcriptions WHERE recording_id=$1)",
			"DELETE FROM provider_operations WHERE job_id IN (SELECT id FROM jobs WHERE recording_id=$1)",
			"UPDATE blobs SET job_id=NULL,job_generation=NULL WHERE job_id IN (SELECT id FROM jobs WHERE recording_id=$1)",
			"DELETE FROM jobs WHERE recording_id=$1",
			"DELETE FROM segments WHERE transcription_id IN (SELECT id FROM transcriptions WHERE recording_id=$1)",
			"DELETE FROM speaker_labels WHERE transcription_id IN (SELECT id FROM transcriptions WHERE recording_id=$1)",
			"DELETE FROM transcriptions WHERE recording_id=$1",
			"DELETE FROM media_assets WHERE recording_id=$1",
			"DELETE FROM recordings WHERE id=$1",
		} {
			if _, err := tx.Exec(ctx, sql, rid); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, "UPDATE blobs SET state='deleting',writer_id=NULL,write_lease_until=NULL WHERE id=ANY($1::uuid[])", ids)
		return err
	})
}
func (a *App) collectBlobs(ctx context.Context) error {
	for i := 0; i < 8; i++ {
		worked := false
		err := persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
			var id string
			err := tx.QueryRow(ctx, `SELECT b.id FROM blobs b WHERE (b.state='deleting' OR b.state='writing' AND COALESCE(b.write_lease_until,b.updated_at)<clock_timestamp()-interval '1 hour' OR b.state='ready' AND b.updated_at<clock_timestamp()-interval '1 hour') AND NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.blob_id=b.id) AND NOT EXISTS(SELECT 1 FROM transcriptions t WHERE t.raw_response_blob_id=b.id) AND NOT EXISTS(SELECT 1 FROM blob_read_leases l WHERE l.blob_id=b.id AND l.expires_at>clock_timestamp()) ORDER BY b.id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id)
			if err == pgx.ErrNoRows {
				return nil
			}
			if err != nil {
				return err
			}
			worked = true
			if _, err := tx.Exec(ctx, "UPDATE blobs SET state='deleting',writer_id=NULL,write_lease_until=NULL WHERE id=$1", id); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "DELETE FROM blob_chunks WHERE blob_id=$1 AND ordinal IN (SELECT ordinal FROM blob_chunks WHERE blob_id=$1 ORDER BY ordinal LIMIT 64)", id); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "DELETE FROM blob_read_leases WHERE blob_id=$1 AND expires_at<=clock_timestamp()", id); err != nil {
				return err
			}
			_, err = tx.Exec(ctx, "DELETE FROM blobs WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM blob_chunks WHERE blob_id=$1)", id)
			return err
		})
		if err != nil {
			return err
		}
		if !worked {
			break
		}
	}
	return nil
}
