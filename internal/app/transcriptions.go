package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
	"voices/internal/providers"
)

func (a *App) listTranscriptions(w http.ResponseWriter, r *http.Request) error {
	limit, offset, err := paging(r)
	if err != nil {
		return err
	}
	if _, err := a.recording(r.Context(), r.PathValue("id")); err != nil {
		return err
	}
	items, err := many(r.Context(), a.DB, "SELECT "+transcriptionColumns+" FROM transcriptions t WHERE recording_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3", r.PathValue("id"), limit+1, offset)
	if err != nil {
		return err
	}
	page(w, items, limit, offset)
	return nil
}
func (a *App) getTranscription(w http.ResponseWriter, r *http.Request) error {
	item, err := one(r.Context(), a.DB, "SELECT "+transcriptionColumns+" FROM transcriptions t JOIN recordings r ON r.id=t.recording_id WHERE t.id=$1 AND r.state<>'deleting'", r.PathValue("id"))
	if err != nil {
		return err
	}
	labels, err := many(r.Context(), a.DB, "SELECT "+labelColumns+" FROM speaker_labels l LEFT JOIN people p ON p.id=l.person_id WHERE l.transcription_id=$1 ORDER BY l.display_name,l.id", r.PathValue("id"))
	if err != nil {
		return err
	}
	var result map[string]any
	if err := json.Unmarshal(item, &result); err != nil {
		return err
	}
	result["speaker_labels"] = labels
	writeJSON(w, 200, result)
	return nil
}
func (a *App) insertTranscription(ctx context.Context, tx pgx.Tx, recordingID string, o providers.Options, m providers.Model, dedupe string) (string, string, error) {
	id, job := uuid.NewString(), uuid.NewString()
	if _, err := tx.Exec(ctx, "INSERT INTO transcriptions(id,recording_id,provider,model,options_json,capability_snapshot_json,state) VALUES($1,$2,$3,$4,$5,$6,'queued')", id, recordingID, o.Provider, o.Model, jsonBytes(o), jsonBytes(m)); err != nil {
		return "", "", err
	}
	if dedupe == "" {
		dedupe = "transcribe:" + id
	}
	_, err := tx.Exec(ctx, "INSERT INTO jobs(id,kind,recording_id,transcription_id,dedupe_key,stage,state) VALUES($1,'transcribe',$2,$3,$4,'uploading','queued')", job, recordingID, id, dedupe)
	return id, job, err
}
func (a *App) createTranscription(w http.ResponseWriter, r *http.Request) error {
	if a.Config.RestoreMode {
		return &apiError{409, "restore_mode", "恢复核对期间不能启动转写"}
	}
	key, err := requestKey(r)
	if err != nil {
		return err
	}
	var in struct {
		providers.Options
		Acknowledge bool `json:"acknowledge_duplicate_risk"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	var id, job string
	hash := digest(jsonBytes(in))
	rid := r.PathValue("id")
	err = persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		var state string
		var duration, size int64
		if err := tx.QueryRow(r.Context(), "SELECT state,duration_ms,size_bytes FROM recordings WHERE id=$1 FOR UPDATE", rid).Scan(&state, &duration, &size); err != nil {
			return err
		}
		if state != "ready" {
			return &apiError{409, "recording_not_ready", "请等待音频准备完成"}
		}
		old, err := claimKey(r.Context(), tx, "transcription:"+rid, key, hash)
		if err != nil {
			return err
		}
		if old != "" {
			id = old
			return tx.QueryRow(r.Context(), "SELECT id FROM jobs WHERE transcription_id=$1", id).Scan(&job)
		}
		var risky bool
		if err := tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM jobs WHERE recording_id=$1 AND kind='transcribe' AND state IN ('uncertain','restore_hold'))", rid).Scan(&risky); err != nil {
			return err
		}
		if risky && !in.Acknowledge {
			return &apiError{409, "duplicate_risk_acknowledgement_required", "旧任务状态尚不确定，新建可能重复收费，请明确确认"}
		}
		model, err := a.validateOptions(in.Options, duration, size)
		if err != nil {
			return err
		}
		id, job, err = a.insertTranscription(r.Context(), tx, rid, in.Options, model, "")
		if err != nil {
			return err
		}
		return saveKey(r.Context(), tx, "transcription:"+rid, key, hash, id)
	})
	if err != nil {
		return err
	}
	t, err := one(r.Context(), a.DB, "SELECT "+transcriptionColumns+" FROM transcriptions t WHERE id=$1", id)
	if err != nil {
		return err
	}
	j, err := one(r.Context(), a.DB, "SELECT "+jobColumns+" FROM jobs j WHERE id=$1", job)
	if err != nil {
		return err
	}
	writeJSON(w, 202, map[string]any{"transcription": t, "job": j})
	return nil
}
func (a *App) activateTranscription(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Revision int64 `json:"revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	var rid string
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), "SELECT recording_id FROM transcriptions WHERE id=$1", r.PathValue("id")).Scan(&rid); err != nil {
			return err
		}
		var state string
		if err := tx.QueryRow(r.Context(), "SELECT state FROM recordings WHERE id=$1 FOR UPDATE", rid).Scan(&state); err != nil {
			return err
		}
		if state == "deleting" {
			return notFound()
		}
		var revision int64
		if err := tx.QueryRow(r.Context(), "SELECT state,revision FROM transcriptions WHERE id=$1 FOR UPDATE", r.PathValue("id")).Scan(&state, &revision); err != nil {
			return err
		}
		if revision != in.Revision {
			return conflict()
		}
		if state != "succeeded" {
			return &apiError{409, "not_completed", "只有成功版本可以激活"}
		}
		_, err := tx.Exec(r.Context(), "UPDATE recordings SET active_transcription_id=$2,revision=revision+1 WHERE id=$1", rid, r.PathValue("id"))
		return err
	})
	if err != nil {
		return err
	}
	item, err := a.recording(r.Context(), rid)
	if err != nil {
		return err
	}
	writeJSON(w, 200, item)
	return nil
}
func (a *App) cancelTranscription(w http.ResponseWriter, r *http.Request) error {
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		var rid string
		if err := tx.QueryRow(r.Context(), "SELECT recording_id FROM transcriptions WHERE id=$1", r.PathValue("id")).Scan(&rid); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), "SELECT id FROM recordings WHERE id=$1 FOR UPDATE", rid); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), "UPDATE jobs SET cancel_requested=true,state=CASE WHEN state IN ('uncertain','restore_hold') THEN state ELSE 'cancelled' END,lease_generation=lease_generation+1,lease_owner=NULL,lease_until=NULL WHERE transcription_id=$1 AND state<>'succeeded'", r.PathValue("id"))
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), "UPDATE transcriptions SET state='cancelled',revision=revision+1 WHERE id=$1 AND state NOT IN ('succeeded','uncertain','restore_hold')", r.PathValue("id"))
		return err
	})
	if err != nil {
		return err
	}
	writeJSON(w, 202, map[string]string{"state": "cancel_requested"})
	return nil
}
func (a *App) createLabel(w http.ResponseWriter, r *http.Request) error {
	key, err := requestKey(r)
	if err != nil {
		return err
	}
	var in struct {
		DisplayName string  `json:"display_name"`
		PersonID    *string `json:"person_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	if in.DisplayName == "" || len([]rune(in.DisplayName)) > 200 {
		return bad("invalid_name", "说话人名称须为 1–200 字")
	}
	id := uuid.NewString()
	hash := digest(jsonBytes(in))
	tid := r.PathValue("id")
	err = persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		if err := lockTranscription(r.Context(), tx, tid); err != nil {
			return err
		}
		old, err := claimKey(r.Context(), tx, "label:"+tid, key, hash)
		if err != nil {
			return err
		}
		if old != "" {
			id = old
			return nil
		}
		if in.PersonID != nil {
			if err := assignablePerson(r.Context(), tx, *in.PersonID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(r.Context(), "INSERT INTO speaker_labels(id,transcription_id,display_name,person_id) VALUES($1,$2,$3,$4)", id, tid, in.DisplayName, in.PersonID); err != nil {
			return err
		}
		return saveKey(r.Context(), tx, "label:"+tid, key, hash, id)
	})
	if err != nil {
		return err
	}
	item, err := one(r.Context(), a.DB, "SELECT "+labelColumns+" FROM speaker_labels l LEFT JOIN people p ON p.id=l.person_id WHERE l.id=$1", id)
	if err != nil {
		return err
	}
	writeJSON(w, 201, item)
	return nil
}

// Optional distinguishes omitted from explicit JSON null in PATCH requests.
type Optional[T any] struct {
	Present bool
	Value   *T
}

func (o *Optional[T]) UnmarshalJSON(b []byte) error {
	o.Present = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}
func (a *App) patchLabel(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Revision    int64            `json:"revision"`
		DisplayName *string          `json:"display_name"`
		PersonID    Optional[string] `json:"person_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Revision < 1 {
		return bad("revision_required", "缺少版本号")
	}
	if in.DisplayName != nil {
		*in.DisplayName = strings.TrimSpace(*in.DisplayName)
		if *in.DisplayName == "" || len([]rune(*in.DisplayName)) > 200 {
			return bad("invalid_name", "说话人名称须为 1–200 字")
		}
	}
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		var tid string
		if err := tx.QueryRow(r.Context(), "SELECT transcription_id FROM speaker_labels WHERE id=$1", r.PathValue("id")).Scan(&tid); err != nil {
			return err
		}
		if err := lockTranscription(r.Context(), tx, tid); err != nil {
			return err
		}
		if in.PersonID.Present && in.PersonID.Value != nil {
			if err := assignablePerson(r.Context(), tx, *in.PersonID.Value); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(r.Context(), "UPDATE speaker_labels SET display_name=COALESCE($3,display_name),person_id=CASE WHEN $4 THEN $5::uuid ELSE person_id END,revision=revision+1 WHERE id=$1 AND revision=$2", r.PathValue("id"), in.Revision, in.DisplayName, in.PersonID.Present, in.PersonID.Value)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return conflict()
		}
		return nil
	})
	if err != nil {
		return err
	}
	item, err := one(r.Context(), a.DB, "SELECT "+labelColumns+" FROM speaker_labels l LEFT JOIN people p ON p.id=l.person_id WHERE l.id=$1", r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, 200, item)
	return nil
}
func assignablePerson(ctx context.Context, tx pgx.Tx, id string) error {
	var ok bool
	if err := tx.QueryRow(ctx, "SELECT archived_at IS NULL FROM people WHERE id=$1 AND owner_id=$2 FOR SHARE", id, persistence.UserID(ctx)).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return bad("person_archived", "不能新增已归档人物的关联")
	}
	return nil
}
func lockTranscription(ctx context.Context, tx pgx.Tx, id string) error {
	var state string
	err := tx.QueryRow(ctx, "SELECT r.state FROM recordings r JOIN transcriptions t ON t.recording_id=r.id WHERE t.id=$1 FOR UPDATE OF r", id).Scan(&state)
	if err != nil {
		return err
	}
	if state == "deleting" {
		return notFound()
	}
	return nil
}
