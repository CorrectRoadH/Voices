package app

import (
	"context"
	"github.com/google/uuid"
	"log/slog"
	"regexp"
	"strings"
	"time"
)

var safePostgresCode = regexp.MustCompile(`^postgres:[0-9A-Z]{5}$`)

func runtimeCode(code string) string {
	switch code {
	case "internal", "internal_error", "unavailable", "processing_failed", "auth", "invalid", "rate_limited", "transient", "uncertain", "unsupported", "not_found":
		return code
	}
	if safePostgresCode.MatchString(code) {
		return code
	}
	return "internal"
}
func (a *App) recordRuntime(ctx context.Context, kind, code, requestID, route string, status int, jobID string) {
	if !a.runtimeWriting.CompareAndSwap(false, true) {
		a.runtimeDropped.Add(1)
		return
	}
	defer a.runtimeWriting.Store(false)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 150*time.Millisecond)
	defer cancel()
	var req, job, path, httpStatus any
	if validID(requestID) {
		req = requestID
	}
	if validID(jobID) {
		job = jobID
	}
	// Only a matched ServeMux pattern may be passed, never a URL supplied by a caller.
	if len(route) <= 200 && strings.Contains(route, " /") && !strings.ContainsAny(route, "?\n\r") {
		path = route
	}
	if status >= 500 && status <= 599 {
		httpStatus = status
	}
	_, err := a.DB.Exec(ctx, `INSERT INTO runtime_events(id,instance_id,kind,code,request_id,route,status,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, uuid.NewString(), a.InstanceID, kind, runtimeCode(code), req, path, httpStatus, job)
	if err != nil {
		a.runtimeDropped.Add(1)
	}
}
func (a *App) pruneRuntime(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	_, err := a.DB.Exec(ctx, `DELETE FROM runtime_events WHERE id IN (SELECT id FROM runtime_events WHERE created_at<clock_timestamp()-interval '7 days' ORDER BY created_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`)
	return err
}
func (a *App) runRuntimeCleanup(ctx context.Context) {
	defer a.runtimeCleaning.Store(false)
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	for {
		if err := a.interruptExpiredCalls(ctx); err != nil && ctx.Err() == nil {
			slog.Error("call interruption update failed", "error_type", errorType(err))
		}
		if err := a.pruneRuntime(ctx); err != nil && ctx.Err() == nil {
			slog.Error("runtime cleanup failed", "error_type", errorType(err))
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
