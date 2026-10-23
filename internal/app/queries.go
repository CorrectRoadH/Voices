package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
)

const recordingColumns = `r.id,r.title,r.original_name,r.recorded_at,r.recorded_at_source,r.notes,r.duration_ms,r.size_bytes,r.mime_type,r.state,r.active_transcription_id,r.revision,r.auto_transcribe,r.created_at,COALESCE((SELECT json_agg(person ORDER BY person.display_name,person.id) FROM (SELECT DISTINCT bp.id,bp.display_name FROM segments bs LEFT JOIN speaker_labels bl ON bl.id=CASE bs.assignment_mode WHEN 'inherit' THEN bs.source_speaker_label_id WHEN 'label' THEN bs.assigned_label_id ELSE NULL END JOIN people bp ON bp.id=bl.person_id WHERE bs.transcription_id=r.active_transcription_id AND bp.builtin_key IS NULL) person),'[]'::json) AS people`
const personColumns = `p.id,p.display_name,p.notes,p.archived_at,p.revision,p.created_at,p.builtin_key,p.is_self,(p.avatar_png IS NOT NULL) AS has_avatar,p.avatar_revision`
const transcriptionColumns = `t.id,t.recording_id,t.provider,t.model,t.options_json AS options,t.state,t.error_code,t.revision,t.created_at`
const labelColumns = `l.id,l.transcription_id,l.display_name,l.provider_label,l.person_id,p.display_name AS person_name,l.revision`
const segmentColumns = `s.id,s.transcription_id,t.recording_id,s.ordinal,COALESCE(s.edited_text,s.source_text) AS text,s.source_text,s.edited_text,s.start_ms,s.end_ms,l.id AS speaker_label_id,COALESCE(p.display_name,l.display_name,'未知说话人') AS speaker_name,l.person_id,p.builtin_key AS person_builtin_key,s.assignment_mode,s.revision`
const segmentJoins = ` FROM segments s JOIN transcriptions t ON t.id=s.transcription_id JOIN recordings r ON r.id=t.recording_id LEFT JOIN speaker_labels l ON l.id=CASE s.assignment_mode WHEN 'inherit' THEN s.source_speaker_label_id WHEN 'label' THEN s.assigned_label_id ELSE NULL END LEFT JOIN people p ON p.id=l.person_id `
const jobColumns = `j.id,j.kind,j.recording_id,j.transcription_id,j.state,j.stage,j.attempt,j.error_code,j.error_detail,j.created_at,
(SELECT jr.title FROM recordings jr WHERE jr.id=j.recording_id AND jr.owner_id=j.owner_id AND jr.state<>'deleting') AS recording_title,
(j.state IN ('failed','retry_wait')
 AND EXISTS(SELECT 1 FROM recordings jr WHERE jr.id=j.recording_id AND jr.state<>'deleting')
 AND NOT EXISTS(SELECT 1 FROM provider_operations jo WHERE jo.job_id=j.id AND jo.state IN ('sent','uncertain'))
 AND NOT EXISTS(SELECT 1 FROM provider_resources jp WHERE jp.transcription_id=j.transcription_id AND jp.cleanup_state<>'pending')) AS retry_allowed`

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func one(ctx context.Context, q querier, sql string, args ...any) (json.RawMessage, error) {
	var raw []byte
	err := q.QueryRow(ctx, "SELECT row_to_json(item) FROM ("+sql+") item", args...).Scan(&raw)
	return raw, err
}
func many(ctx context.Context, q querier, sql string, args ...any) ([]json.RawMessage, error) {
	rows, err := q.Query(ctx, "SELECT row_to_json(item) FROM ("+sql+") item", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		out = append(out, json.RawMessage(raw))
	}
	return out, rows.Err()
}
func paging(r *http.Request) (int, int, error) {
	limit := 50
	var err error
	if v := r.URL.Query().Get("limit"); v != "" {
		limit, err = strconv.Atoi(v)
		if err != nil || limit < 1 || limit > 100 {
			return 0, 0, bad("invalid_limit", "每页数量须为 1–100")
		}
	}
	offset := 0
	if v := r.URL.Query().Get("cursor"); v != "" {
		b, e := base64.RawURLEncoding.DecodeString(v)
		if e != nil {
			return 0, 0, bad("invalid_cursor", "分页游标不正确")
		}
		offset, err = strconv.Atoi(string(b))
		if err != nil || offset < 0 || offset > 10000000 {
			return 0, 0, bad("invalid_cursor", "分页游标不正确")
		}
	}
	return limit, offset, nil
}
func cursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}
func page(w http.ResponseWriter, items []json.RawMessage, limit, offset int) {
	var next *string
	if len(items) > limit {
		items = items[:limit]
		c := cursor(offset + limit)
		next = &c
	}
	writeJSON(w, 200, map[string]any{"items": items, "next_cursor": next})
}
func requestKey(r *http.Request) (string, error) {
	key := r.Header.Get("Idempotency-Key")
	if !validID(key) {
		return "", bad("idempotency_key_required", "创建请求需要 UUID Idempotency-Key")
	}
	return key, nil
}

// claimKey serializes same-scope creations without leaving provisional durable rows.
func claimKey(ctx context.Context, tx pgx.Tx, scope, key, hash string) (string, error) {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", persistence.UserID(ctx)+":"+scope+":"+key); err != nil {
		return "", err
	}
	var oldHash, id string
	err := tx.QueryRow(ctx, "SELECT request_hash,resource_id FROM idempotency_keys WHERE scope=$1 AND key=$2 AND owner_id=$3", scope, key, persistence.UserID(ctx)).Scan(&oldHash, &id)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if oldHash != hash {
		return "", conflict()
	}
	return id, nil
}
func saveKey(ctx context.Context, tx pgx.Tx, scope, key, hash, id string) error {
	_, err := tx.Exec(ctx, "INSERT INTO idempotency_keys(scope,key,request_hash,resource_id,owner_id) VALUES($1,$2,$3,$4,$5)", scope, key, hash, id, persistence.UserID(ctx))
	return err
}
func ilike(v string) string {
	return "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(v) + "%"
}
func placeholder(n int) string { return fmt.Sprintf("$%d", n) }
