package app

import (
	"context"
	"github.com/jackc/pgx/v5"
	"net/http"
	"time"
)

func (a *App) adminOverview(w http.ResponseWriter, r *http.Request) error {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	start := time.Now()
	tx, err := a.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return &apiError{503, "unavailable", "无法读取运行状态"}
	}
	defer tx.Rollback(ctx)
	users, err := one(ctx, tx, `SELECT count(*) AS total,count(*) FILTER(WHERE status='active') AS active,count(*) FILTER(WHERE status='disabled') AS disabled,count(*) FILTER(WHERE status='active' AND role='admin') AS admins FROM users`)
	if err != nil {
		return &apiError{503, "unavailable", "无法读取运行状态"}
	}
	jobs, err := one(ctx, tx, `SELECT count(*) FILTER(WHERE state='queued') AS queued,count(*) FILTER(WHERE state='running') AS running,count(*) FILTER(WHERE state='retry_wait') AS retry_wait,count(*) FILTER(WHERE state='failed') AS failed,count(*) FILTER(WHERE state='uncertain') AS uncertain,count(*) FILTER(WHERE state='restore_hold') AS restore_hold,count(*) FILTER(WHERE state='running' AND (lease_until IS NULL OR lease_until<=clock_timestamp())) AS stale_running FROM jobs`)
	if err != nil {
		return &apiError{503, "unavailable", "无法读取运行状态"}
	}
	insightJobs, err := one(ctx, tx, `SELECT count(*) FILTER(WHERE state='queued') AS queued,count(*) FILTER(WHERE state='running') AS running,count(*) FILTER(WHERE state='failed') AS failed FROM transcription_insights`)
	if err != nil {
		return &apiError{503, "unavailable", "无法读取运行状态"}
	}
	var size, cleanup int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE(sum(size_bytes),0) FROM blobs WHERE state='ready'`).Scan(&size); err != nil {
		return &apiError{503, "unavailable", "无法读取运行状态"}
	}
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM provider_resources WHERE cleanup_state='failed'`).Scan(&cleanup); err != nil {
		return &apiError{503, "unavailable", "无法读取运行状态"}
	}
	if err = tx.Commit(ctx); err != nil {
		return &apiError{503, "unavailable", "无法读取运行状态"}
	}
	writeJSON(w, 200, map[string]any{"checked_at": time.Now().UTC(), "instance_id": a.InstanceID, "started_at": a.StartedAt, "uptime_seconds": int64(time.Since(a.StartedAt).Seconds()), "restore_mode": a.Config.RestoreMode, "database": map[string]any{"status": "up", "latency_ms": time.Since(start).Milliseconds()}, "users": users, "jobs": jobs, "insights": insightJobs, "storage": map[string]any{"blob_bytes": size}, "cleanup_failed": cleanup, "limits": map[string]any{"max_upload_bytes": a.Config.MaxUploadBytes, "prepare_concurrency": a.Config.PrepareConcurrency, "transcription_concurrency": a.Config.TranscriptionConcurrency}, "runtime_log_dropped": a.runtimeDropped.Load()})
	return nil
}
