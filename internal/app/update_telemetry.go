package app

import (
	"context"
	"log/slog"
	"time"
	"voices/internal/updates"
)

// UpdateTelemetry reads the persistent installation identity, never the task lease owner.
// @concord-code
// @concord-implements docs/feature/updates/use-case/check-updates.md
func (a *App) UpdateTelemetry(ctx context.Context) *updates.Telemetry {
	if !a.Config.UpdateTelemetry || a.Config.UpdateURL == "" || a.Config.RestoreMode {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var id string
	if err := a.DB.QueryRow(ctx, "SELECT instance_id::text FROM instance_identity WHERE id=1").Scan(&id); err != nil {
		slog.Warn("update telemetry identity unavailable; continuing without telemetry")
		return nil
	}
	return &updates.Telemetry{InstanceID: id}
}
