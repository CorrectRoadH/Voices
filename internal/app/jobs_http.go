package app

import (
	"context"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
	"voices/internal/providers"
)

func (a *App) listJobs(w http.ResponseWriter, r *http.Request) error {
	limit, offset, err := paging(r)
	if err != nil {
		return err
	}
	var rid any
	if r.URL.Query().Get("recording_id") != "" {
		rid = r.URL.Query().Get("recording_id")
	}
	items, err := many(r.Context(), a.DB, "SELECT "+jobColumns+", COALESCE((SELECT json_agg(json_build_object('id',o.id,'kind',o.kind,'state',o.state,'remote_id',o.remote_id,'resolution_note',o.resolution_note) ORDER BY o.created_at) FROM provider_operations o WHERE o.job_id=j.id),'[]'::json) AS operations FROM jobs j WHERE j.owner_id=$5 AND ($1::uuid IS NULL OR j.recording_id=$1) AND ($2='' OR j.state=$2) ORDER BY j.created_at DESC,j.id LIMIT $3 OFFSET $4", rid, r.URL.Query().Get("state"), limit+1, offset, persistence.UserID(r.Context()))
	if err != nil {
		return err
	}
	page(w, items, limit, offset)
	return nil
}
func (a *App) retryJob(w http.ResponseWriter, r *http.Request) error {
	if a.Config.RestoreMode {
		return &apiError{409, "restore_mode", "恢复核对期间不能重试"}
	}
	var in struct{}
	if err := decode(r, &in); err != nil {
		return err
	}
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		var rid, kind, state string
		var tid *string
		if err := tx.QueryRow(r.Context(), "SELECT recording_id FROM jobs WHERE id=$1", r.PathValue("id")).Scan(&rid); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), "SELECT state FROM recordings WHERE id=$1 FOR UPDATE", rid).Scan(&state); err != nil {
			return err
		}
		if state == "deleting" {
			return &apiError{409, "deleting", "录音正在删除"}
		}
		if err := tx.QueryRow(r.Context(), "SELECT kind,state,transcription_id FROM jobs WHERE id=$1 FOR UPDATE", r.PathValue("id")).Scan(&kind, &state, &tid); err != nil {
			return err
		}
		if state != "failed" && state != "retry_wait" {
			return &apiError{409, "unsafe_retry", "当前任务不能安全重试；不确定任务须先核对远端 ID"}
		}
		var unsafe bool
		if err := tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM provider_operations WHERE job_id=$1 AND state IN ('sent','uncertain'))", r.PathValue("id")).Scan(&unsafe); err != nil {
			return err
		}
		if unsafe {
			return &apiError{409, "unsafe_retry", "存在可能已受理的请求，请先核对远端 ID"}
		}
		var deleted bool
		if err := tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM provider_resources WHERE transcription_id=$1 AND cleanup_state<>'pending')", tid).Scan(&deleted); err != nil {
			return err
		}
		if deleted {
			return &apiError{409, "resources_cleaned", "远端资源已开始清理，请新建转写版本"}
		}
		if _, err := tx.Exec(r.Context(), "UPDATE jobs SET state='queued',attempt=0,error_code=NULL,next_run_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,cancel_requested=false WHERE id=$1", r.PathValue("id")); err != nil {
			return err
		}
		if kind == "prepare" {
			_, err := tx.Exec(r.Context(), "UPDATE recordings SET state='preparing',revision=revision+1 WHERE id=$1", rid)
			return err
		}
		_, err := tx.Exec(r.Context(), "UPDATE transcriptions SET state='queued',error_code=NULL,revision=revision+1 WHERE id=$1", tid)
		return err
	})
	if err != nil {
		return err
	}
	writeJSON(w, 202, map[string]string{"state": "queued"})
	return nil
}

type reconciliation struct {
	OperationID *string `json:"operation_id"`
	RemoteID    *string `json:"remote_id"`
	Note        string  `json:"note"`
}

func (a *App) resolveJob(w http.ResponseWriter, r *http.Request) error {
	var in reconciliation
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := a.reconcileJob(r.Context(), r.PathValue("id"), in, false); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]string{"state": "recorded"})
	return nil
}

// ReconcileJob is only exposed to the trusted local operator CLI.
func (a *App) ReconcileJob(ctx context.Context, jobID, operationID, remoteID, note string) error {
	if !validID(jobID) || !validID(operationID) {
		return bad("invalid_id", "任务或操作 ID 不正确")
	}
	return a.reconcileJob(ctx, jobID, reconciliation{OperationID: &operationID, RemoteID: &remoteID, Note: note}, true)
}
func (a *App) reconcileJob(ctx context.Context, jobID string, in reconciliation, trustedOperator bool) error {
	in.Note = strings.TrimSpace(in.Note)
	if in.Note == "" || len(in.Note) > 5000 {
		return bad("note_required", "请记录核对依据（最多 5000 字节）")
	}
	if in.RemoteID != nil && (*in.RemoteID == "" || len(*in.RemoteID) > 4096) {
		return bad("invalid_remote_id", "远端 ID 不正确")
	}
	return persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		var rid, state, tid, provider string
		if err := tx.QueryRow(ctx, "SELECT j.recording_id,j.transcription_id,t.provider FROM jobs j JOIN transcriptions t ON t.id=j.transcription_id WHERE j.id=$1", jobID).Scan(&rid, &tid, &provider); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "SELECT id FROM recordings WHERE id=$1 FOR UPDATE", rid); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, "SELECT state FROM jobs WHERE id=$1 FOR UPDATE", jobID).Scan(&state); err != nil {
			return err
		}
		if state != "uncertain" && state != "restore_hold" {
			return &apiError{409, "not_reconcilable", "当前任务无需人工核对"}
		}
		var op, kind string
		if in.OperationID != nil {
			if err := tx.QueryRow(ctx, "SELECT id,kind FROM provider_operations WHERE id=$1 AND job_id=$2 FOR UPDATE", *in.OperationID, jobID).Scan(&op, &kind); err != nil {
				return err
			}
		} else {
			err := tx.QueryRow(ctx, "SELECT id,kind FROM provider_operations WHERE job_id=$1 AND state IN ('sent','uncertain') ORDER BY created_at DESC LIMIT 1 FOR UPDATE", jobID).Scan(&op, &kind)
			if err != nil && err != pgx.ErrNoRows {
				return err
			}
			if err == pgx.ErrNoRows {
				if in.RemoteID != nil {
					return bad("operation_required", "请先核对快照之外的转写 ID；无操作记录的恢复任务须保留隔离，不能推断资源归属")
				}
				_, err := tx.Exec(ctx, "UPDATE jobs SET error_code='restore_observation_recorded' WHERE id=$1", jobID)
				return err
			}
		}
		if in.RemoteID != nil && !trustedOperator {
			var known bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM provider_operations WHERE id=$1 AND remote_id=$2 AND state='known')", op, *in.RemoteID).Scan(&known); err != nil {
				return err
			}
			if !known {
				return &apiError{403, "operator_reconciliation_required", "未知远端 ID 需要由运维者核实归属后登记；此处可以保存查询观察"}
			}
		}
		if trustedOperator {
			if err := audit(ctx, tx, nil, nil, "job_reconciled", map[string]any{"job_id": jobID, "operation_id": op}); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, "UPDATE provider_operations SET resolution_note=$2 WHERE id=$1", op, in.Note); err != nil {
			return err
		}
		if in.RemoteID == nil {
			return nil
		}
		resourceKind := "file"
		if kind == "submit" {
			resourceKind = "transcription"
		}
		if err := registerResourceTx(ctx, tx, op, provider, providers.Resource{ID: *in.RemoteID, Kind: resourceKind}); err != nil {
			return err
		}
		// Restore quarantine remains until all possibly dispatched operations are known.
		// A known upload alone never permits a post-snapshot submit to be replayed.
		var unresolved bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM provider_operations WHERE job_id=$1 AND state IN ('sent','uncertain'))", jobID).Scan(&unresolved); err != nil {
			return err
		}
		if unresolved {
			return nil
		}
		if a.Config.RestoreMode {
			return nil
		}
		_, err := tx.Exec(ctx, "UPDATE jobs SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'queued' END,stage=CASE WHEN EXISTS(SELECT 1 FROM provider_operations WHERE job_id=$1 AND kind='submit' AND state='known') THEN 'polling' ELSE 'submitting' END,attempt=0,error_code=NULL,next_run_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL WHERE id=$1", jobID)
		return err
	})
}
