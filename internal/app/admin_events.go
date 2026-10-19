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
)

type eventCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        string    `json:"id"`
}

var auditActions = map[string]bool{"account_updated": true, "registration_updated": true, "server_settings_updated": true, "password_reset": true, "job_reconciled": true}
var runtimeKinds = map[string]bool{"request_failed": true, "job_failed": true, "job_claim_failed": true, "maintenance_failed": true, "job_failure_persistence_failed": true}

func eventQuery(r *http.Request, runtime bool) (string, []any, int, error) {
	q := r.URL.Query()
	limit := 50
	if v := q.Get("limit"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil || n < 1 || n > 100 {
			return "", nil, 0, bad("invalid_limit", "每页数量须为 1–100")
		}
		limit = n
	}
	where := []string{"true"}
	args := []any{}
	add := func(clause string, value any) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}
	var from, to time.Time
	for _, key := range []string{"from", "to"} {
		if v := q.Get(key); v != "" {
			t, e := time.Parse(time.RFC3339Nano, v)
			if e != nil {
				return "", nil, 0, bad("invalid_date", "时间格式不正确")
			}
			if key == "from" {
				from = t
				add("e.created_at >= $%d", t)
			} else {
				to = t
				add("e.created_at < $%d", t)
			}
		}
	}
	if !from.IsZero() && !to.IsZero() && !from.Before(to) {
		return "", nil, 0, bad("invalid_date", "起始时间须早于结束时间")
	}
	if v := q.Get("cursor"); v != "" {
		var c eventCursor
		b, e := base64.RawURLEncoding.DecodeString(v)
		d := json.NewDecoder(bytes.NewReader(b))
		d.DisallowUnknownFields()
		if len(v) > 512 || e != nil || d.Decode(&c) != nil || !validID(c.ID) || c.CreatedAt.IsZero() {
			return "", nil, 0, bad("invalid_cursor", "分页游标不正确")
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			return "", nil, 0, bad("invalid_cursor", "分页游标不正确")
		}
		args = append(args, c.CreatedAt, c.ID)
		where = append(where, fmt.Sprintf("(e.created_at,e.id)<($%d,$%d::uuid)", len(args)-1, len(args)))
	}
	kind := "action"
	allowed := auditActions
	ids := []string{"actor_id", "target_user_id"}
	if runtime {
		kind = "kind"
		allowed = runtimeKinds
		ids = []string{"request_id", "job_id"}
		where = append(where, "e.created_at>=clock_timestamp()-interval '7 days'")
	}
	if v := q.Get(kind); v != "" {
		if !allowed[v] {
			return "", nil, 0, bad("invalid_filter", "未知事件类型")
		}
		add("e."+kind+"=$%d", v)
	}
	for _, key := range ids {
		if v := q.Get(key); v != "" {
			if !validID(v) {
				return "", nil, 0, bad("invalid_filter", "ID 格式不正确")
			}
			add("e."+key+"=$%d::uuid", v)
		}
	}
	args = append(args, limit+1)
	return " WHERE " + strings.Join(where, " AND ") + fmt.Sprintf(" ORDER BY e.created_at DESC,e.id DESC LIMIT $%d", len(args)), args, limit, nil
}
func safeAuditDetails(action string, raw json.RawMessage) map[string]any {
	in := map[string]any{}
	_ = json.Unmarshal(raw, &in)
	out := map[string]any{}
	switch action {
	case "account_updated":
		for _, k := range []string{"old_role", "role", "old_status", "status"} {
			v, _ := in[k].(string)
			if ((k == "role" || k == "old_role") && (v == "admin" || v == "user")) || ((k == "status" || k == "old_status") && (v == "active" || v == "disabled")) {
				out[k] = v
			}
		}
	case "registration_updated":
		if v, ok := in["registration_open"].(bool); ok {
			out["registration_open"] = v
		}
	case "server_settings_updated":
		fields := []string{}
		if values, ok := in["fields"].([]any); ok {
			for _, v := range values {
				s, _ := v.(string)
				switch s {
				case "public_base_url", "allowed_origins", "soniox_api_key", "assemblyai_api_key", "llm_base_url", "llm_model", "llm_api_key":
					fields = append(fields, s)
				}
			}
		}
		out["fields"] = fields
	case "job_reconciled":
		for _, k := range []string{"job_id", "operation_id"} {
			if s, ok := in[k].(string); ok && validID(s) {
				out[k] = s
			}
		}
	}
	return out
}
func (a *App) adminAuditEvents(w http.ResponseWriter, r *http.Request) error {
	return a.adminEvents(w, r, false)
}
func (a *App) adminRuntimeEvents(w http.ResponseWriter, r *http.Request) error {
	return a.adminEvents(w, r, true)
}
func (a *App) adminEvents(w http.ResponseWriter, r *http.Request, runtime bool) error {
	suffix, args, limit, err := eventQuery(r, runtime)
	if err != nil {
		return err
	}
	query := `SELECT e.id,e.created_at,e.action,CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id',u.id,'email',u.email,'display_name',u.display_name) END AS actor,CASE WHEN t.id IS NULL THEN NULL ELSE json_build_object('id',t.id,'email',t.email,'display_name',t.display_name) END AS target,e.details FROM admin_audit_events e LEFT JOIN users u ON u.id=e.actor_id LEFT JOIN users t ON t.id=e.target_user_id`
	if runtime {
		query = `SELECT e.id,e.created_at,e.instance_id,e.kind,e.code,e.request_id,e.route,e.status,e.job_id FROM runtime_events e`
	}
	items, err := many(r.Context(), a.DB, query+suffix, args...)
	if err != nil {
		return err
	}
	var next *string
	if len(items) > limit {
		items = items[:limit]
		var c eventCursor
		if err = json.Unmarshal(items[len(items)-1], &c); err != nil {
			return err
		}
		s := base64.RawURLEncoding.EncodeToString(jsonBytes(c))
		next = &s
	}
	if !runtime {
		for i, raw := range items {
			var item map[string]json.RawMessage
			if err = json.Unmarshal(raw, &item); err != nil {
				return err
			}
			var action string
			_ = json.Unmarshal(item["action"], &action)
			item["details"] = jsonBytes(safeAuditDetails(action, item["details"]))
			items[i] = jsonBytes(item)
		}
	}
	writeJSON(w, 200, map[string]any{"items": items, "next_cursor": next})
	return nil
}
