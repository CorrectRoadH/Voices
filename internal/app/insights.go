package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"voices/internal/insights"
	"voices/internal/persistence"
)

func (a *App) insightsConfigured() bool { return a.Config.LLMBaseURL != "" && a.Config.LLMModel != "" }
func transcriptSnapshot(ctx context.Context, q querier, tid string) ([]insights.Segment, string, error) {
	rows, err := q.Query(ctx, `SELECT id,start_ms,end_ms,COALESCE(edited_text,source_text) FROM segments WHERE transcription_id=$1 ORDER BY ordinal,id LIMIT 5001`, tid)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []insights.Segment{}
	size := 0
	hasText := false
	for rows.Next() {
		var s insights.Segment
		if err = rows.Scan(&s.ID, &s.StartMS, &s.EndMS, &s.Text); err != nil {
			return nil, "", err
		}
		size += len(s.Text)
		if len(out) >= 5000 || size > 200000 {
			return nil, "", &apiError{422, "transcript_too_large", "当前支持最多 5000 个片段、200000 字节的转写"}
		}
		out = append(out, s)
		hasText = hasText || strings.TrimSpace(s.Text) != ""
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	if !hasText {
		return nil, "", &apiError{422, "empty_transcript", "转写正文为空，无法生成摘要"}
	}
	return out, digest(jsonBytes(out)), nil
}

type insightView struct {
	Generation string    `json:"generation"`
	State      string    `json:"state"`
	Model      string    `json:"model"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
	ErrorCode  *string   `json:"error_code"`
	Stale      bool      `json:"stale"`
	insights.Result
}

func (a *App) insightResponse(ctx context.Context, tid string) (map[string]any, error) {
	var exists bool
	if err := a.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM transcriptions t JOIN recordings r ON r.id=t.recording_id WHERE t.id=$1 AND r.state<>'deleting')`, tid).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, notFound()
	}
	out := map[string]any{"configured": a.insightsConfigured(), "insight": nil}
	var v insightView
	var hash string
	var raw []byte
	err := a.DB.QueryRow(ctx, `SELECT generation,state,model,created_at,updated_at,error_code,source_hash,result_json FROM transcription_insights WHERE transcription_id=$1`, tid).Scan(&v.Generation, &v.State, &v.Model, &v.CreatedAt, &v.UpdatedAt, &v.ErrorCode, &hash, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	v.Chapters = []insights.Chapter{}
	if raw != nil {
		if err = json.Unmarshal(raw, &v.Result); err != nil {
			return nil, err
		}
	}
	_, current, err := transcriptSnapshot(ctx, a.DB, tid)
	if err != nil {
		var ae *apiError
		if !errors.As(err, &ae) {
			return nil, err
		}
	}
	v.Stale = hash != current
	out["insight"] = v
	return out, nil
}
func (a *App) getInsights(w http.ResponseWriter, r *http.Request) error {
	out, err := a.insightResponse(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, 200, out)
	return nil
}
func (a *App) createInsights(w http.ResponseWriter, r *http.Request) error {
	key, err := requestKey(r)
	if err != nil {
		return err
	}
	var in struct{}
	if err = decode(r, &in); err != nil {
		return err
	}
	tid := r.PathValue("id")
	ctx := r.Context()
	scope := "insights:" + tid
	err = persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if err := lockTranscription(ctx, tx, tid); err != nil {
			return err
		}
		old, err := claimKey(ctx, tx, scope, key, "v1")
		if err != nil {
			return err
		}
		var generation, state string
		e := tx.QueryRow(ctx, `SELECT generation,state FROM transcription_insights WHERE transcription_id=$1`, tid).Scan(&generation, &state)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if old != "" {
			if generation != old {
				return conflict()
			}
			return nil
		}
		if state == "queued" || state == "running" {
			return &apiError{409, "generation_in_progress", "当前版本正在生成摘要"}
		}
		if !a.insightsConfigured() {
			return &apiError{409, "llm_not_configured", "请管理员配置 LLM 地址和模型并重启服务"}
		}
		if err = tx.QueryRow(ctx, "SELECT state FROM transcriptions WHERE id=$1", tid).Scan(&state); err != nil {
			return err
		}
		if state != "succeeded" {
			return &apiError{409, "not_completed", "仅支持已完成的转写版本"}
		}
		snapshot, hash, err := transcriptSnapshot(ctx, tx, tid)
		if err != nil {
			return err
		}
		generation = uuid.NewString()
		_, err = tx.Exec(ctx, `INSERT INTO transcription_insights(transcription_id,generation,state,source_hash,input_json,model) VALUES($1,$2,'queued',$3,$4,$5) ON CONFLICT(transcription_id) DO UPDATE SET generation=EXCLUDED.generation,state='queued',source_hash=EXCLUDED.source_hash,input_json=EXCLUDED.input_json,result_json=NULL,model=EXCLUDED.model,error_code=NULL,lease_until=NULL,created_at=clock_timestamp(),updated_at=clock_timestamp()`, tid, generation, hash, jsonBytes(snapshot), a.Config.LLMModel)
		if err != nil {
			return err
		}
		return saveKey(ctx, tx, scope, key, "v1", generation)
	})
	if err != nil {
		return err
	}
	out, err := a.insightResponse(ctx, tid)
	if err != nil {
		return err
	}
	writeJSON(w, 202, out)
	return nil
}

type insightWork struct {
	TID, Generation, Model string
	Input                  []insights.Segment
}

func (a *App) claimInsight(ctx context.Context) (insightWork, error) {
	var work insightWork
	if a.Config.RestoreMode {
		return work, pgx.ErrNoRows
	}
	err := persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(771940005)"); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE transcription_insights SET state='failed',error_code='interrupted',input_json=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE state='running' AND lease_until<=clock_timestamp()`); err != nil {
			return err
		}
		var running bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM transcription_insights WHERE state='running')`).Scan(&running); err != nil {
			return err
		}
		if running {
			return nil
		}
		var raw []byte
		var status string
		if err := tx.QueryRow(ctx, `SELECT i.transcription_id,i.generation,i.model,i.input_json,u.status FROM transcription_insights i JOIN transcriptions t ON t.id=i.transcription_id JOIN recordings r ON r.id=t.recording_id JOIN users u ON u.id=r.owner_id WHERE i.state='queued' AND r.state<>'deleting' AND t.state='succeeded' ORDER BY i.created_at,i.transcription_id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`).Scan(&work.TID, &work.Generation, &work.Model, &raw, &status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		if status != "active" {
			_, err := tx.Exec(ctx, `UPDATE transcription_insights SET state='failed',error_code='account_disabled',input_json=NULL,updated_at=clock_timestamp() WHERE transcription_id=$1`, work.TID)
			work.TID = ""
			return err
		}
		if err := json.Unmarshal(raw, &work.Input); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE transcription_insights SET state='running',lease_until=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() WHERE transcription_id=$1 AND generation=$2 AND state='queued'`, work.TID, work.Generation)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err == nil && work.TID == "" {
		err = pgx.ErrNoRows
	}
	return work, err
}
func (a *App) executeInsight(ctx context.Context, work insightWork) {
	var result insights.Result
	var err error
	if !a.insightsConfigured() || work.Model != a.Config.LLMModel {
		err = insights.Error("configuration_changed")
	} else {
		result, err = insights.Generate(ctx, a.Config.LLMBaseURL, a.Config.LLMKey, work.Model, work.Input)
	}
	finalCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	persistErr := persistence.Transaction(finalCtx, a.DB, func(tx pgx.Tx) error {
		if e := lockTranscription(finalCtx, tx, work.TID); e != nil {
			return e
		}
		state := "succeeded"
		var code any
		var raw any = jsonBytes(result)
		if err != nil {
			state = "failed"
			raw = nil
			code = "llm_unavailable"
			var safe insights.Error
			if errors.As(err, &safe) {
				code = string(safe)
			}
		}
		_, e := tx.Exec(finalCtx, `UPDATE transcription_insights SET state=$3,result_json=$4,error_code=$5,input_json=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE transcription_id=$1 AND generation=$2 AND state='running' AND lease_until>clock_timestamp()`, work.TID, work.Generation, state, raw, code)
		return e
	})
	if persistErr != nil && !errors.Is(persistErr, pgx.ErrNoRows) {
		var api *apiError
		if !errors.As(persistErr, &api) || api.Status != 404 {
			slog.Error("insight result persistence failed", "generation", work.Generation, "error_type", errorType(persistErr))
		}
	}
}
