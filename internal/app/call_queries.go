package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const effectiveCallState = `CASE WHEN e.state='running' AND e.deadline_at<=clock_timestamp() THEN 'interrupted' ELSE e.state END`

var callEnums = map[string]string{
	"category": "stt ai", "operation": "upload submit poll fetch_result delete_file delete_transcription generate_insights list_models test_model",
	"provider": "soniox assemblyai openai_compatible", "state": "running succeeded failed uncertain interrupted",
}

type callCursor struct {
	StartedAt time.Time `json:"started_at"`
	ID        string    `json:"id"`
}

func callQuery(r *http.Request, admin bool) (string, []any, int, error) {
	q := r.URL.Query()
	args := []any{}
	where := []string{"true"}
	add := func(clause string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}
	if !admin {
		if q.Has("owner_id") || q.Has("account") {
			return "", nil, 0, bad("invalid_filter", "个人调用记录不支持账号筛选")
		}
		add("e.owner_id=$%d::uuid", currentUser(r.Context()).ID)
	}
	allowed := map[string]bool{"limit": true, "cursor": true, "model": true, "from": true, "to": true, "job_id": true, "recording_id": true, "transcription_id": true, "generation": true, "owner_id": admin, "account": admin}
	for key := range callEnums {
		allowed[key] = true
	}
	for key, values := range q {
		if !allowed[key] || len(values) != 1 {
			return "", nil, 0, bad("invalid_filter", "未知或重复筛选参数")
		}
	}
	for key, values := range callEnums {
		if v := q.Get(key); v != "" {
			found := false
			for _, option := range strings.Fields(values) {
				if option == v {
					found = true
				}
			}
			if !found {
				return "", nil, 0, bad("invalid_filter", "未知调用筛选值")
			}
			column := "e." + key
			if key == "state" {
				column = "(" + effectiveCallState + ")"
			}
			add(column+"=$%d", v)
		}
	}
	for _, key := range []string{"job_id", "recording_id", "transcription_id", "generation", "owner_id"} {
		if v := q.Get(key); v != "" {
			if !validID(v) {
				return "", nil, 0, bad("invalid_filter", "ID 格式不正确")
			}
			add("e."+key+"=$%d::uuid", v)
		}
	}
	for _, key := range []string{"model", "account"} {
		if v := q.Get(key); v != "" {
			if !utf8.ValidString(v) || utf8.RuneCountInString(v) > 200 {
				return "", nil, 0, bad("invalid_filter", "筛选文本过长")
			}
			if key == "model" {
				add("e.model=$%d", v)
			} else {
				v = "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(v) + "%"
				args = append(args, v)
				n := len(args)
				where = append(where, fmt.Sprintf("(u.email ILIKE $%d OR u.username ILIKE $%d OR u.display_name ILIKE $%d)", n, n, n))
			}
		}
	}
	var from, to time.Time
	for _, key := range []string{"from", "to"} {
		if v := q.Get(key); v != "" {
			t, err := time.Parse(time.RFC3339Nano, v)
			if err != nil {
				return "", nil, 0, bad("invalid_date", "时间格式不正确")
			}
			if key == "from" {
				from = t
				add("e.started_at >= $%d", t)
			} else {
				to = t
				add("e.started_at < $%d", t)
			}
		}
	}
	if !from.IsZero() && !to.IsZero() && !from.Before(to) {
		return "", nil, 0, bad("invalid_date", "起始时间须早于结束时间")
	}
	if v := q.Get("cursor"); v != "" {
		if len(v) > 512 {
			return "", nil, 0, bad("invalid_cursor", "分页游标不正确")
		}
		raw, err := base64.RawURLEncoding.Strict().DecodeString(v)
		var c callCursor
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		var extra any
		if err != nil || d.Decode(&c) != nil || d.Decode(&extra) != io.EOF || c.StartedAt.IsZero() || !validID(c.ID) {
			return "", nil, 0, bad("invalid_cursor", "分页游标不正确")
		}
		args = append(args, c.StartedAt, c.ID)
		where = append(where, fmt.Sprintf("(e.started_at,e.id)<($%d,$%d::uuid)", len(args)-1, len(args)))
	}
	limit := 50
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			return "", nil, 0, bad("invalid_limit", "每页数量须为 1–100")
		}
		limit = n
	}
	args = append(args, limit+1)
	return " WHERE " + strings.Join(where, " AND ") + fmt.Sprintf(" ORDER BY e.started_at DESC,e.id DESC LIMIT $%d", len(args)), args, limit, nil
}
func (a *App) listCalls(w http.ResponseWriter, r *http.Request) error {
	return a.queryCalls(w, r, false)
}
func (a *App) adminCalls(w http.ResponseWriter, r *http.Request) error {
	return a.queryCalls(w, r, true)
}
func (a *App) queryCalls(w http.ResponseWriter, r *http.Request, admin bool) error {
	tail, args, limit, err := callQuery(r, admin)
	if err != nil {
		return err
	}
	// Construct the public object explicitly: no internal deadline or future columns leak.
	actor := "'null'::jsonb"
	if admin {
		actor = "jsonb_build_object('id',u.id,'email',u.email,'display_name',u.display_name)"
	}
	args = append(args, currentUser(r.Context()).ID)
	viewer := fmt.Sprintf("$%d::uuid", len(args))
	sql := `SELECT jsonb_build_object('id',e.id,'category',e.category,'operation',e.operation,'provider',e.provider,'model',e.model,'recording_id',e.recording_id,'transcription_id',e.transcription_id,'job_id',e.job_id,'operation_id',e.operation_id,'generation',e.generation,'started_at',e.started_at,'finished_at',e.finished_at,'duration_ms',e.duration_ms,'state',` + effectiveCallState + `,'request_started',e.request_started,'http_status',e.http_status,'audio_duration_ms',e.audio_duration_ms,'input_tokens',e.input_tokens,'output_tokens',e.output_tokens,'total_tokens',e.total_tokens,'error_code',CASE WHEN e.state='running' AND e.deadline_at<=clock_timestamp() THEN 'interrupted' ELSE e.error_code END,'error_reason',e.error_reason,'actor',` + actor + `,'recording_available',r.id IS NOT NULL AND r.state<>'deleting','can_open_recording',COALESCE(r.owner_id=` + viewer + ` AND r.state<>'deleting',false)),e.started_at,e.id FROM external_calls e JOIN users u ON u.id=e.owner_id LEFT JOIN recordings r ON r.id=e.recording_id` + tail
	rows, err := a.DB.Query(r.Context(), sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []json.RawMessage{}
	var last callCursor
	var next *string
	for rows.Next() {
		var raw json.RawMessage
		var c callCursor
		if err := rows.Scan(&raw, &c.StartedAt, &c.ID); err != nil {
			return err
		}
		if len(items) == limit {
			b, _ := json.Marshal(last)
			v := base64.RawURLEncoding.EncodeToString(b)
			next = &v
			break
		}
		items = append(items, raw)
		last = c
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"items": items, "next_cursor": next, "retention_days": nil})
	return nil
}
