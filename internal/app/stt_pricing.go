// @concord-file
// @concord-implements docs/feature/stt-pricing/README.md
// @concord-implements docs/feature/stt-pricing/use-case/manage-estimates.md
package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type sttQuery struct {
	where   string
	args    []any
	limit   int
	cursor  *eventCursor
	history bool
}

func parseSTTQuery(r *http.Request, prices bool) (sttQuery, error) {
	f := sttQuery{where: " WHERE true", limit: 50}
	q := r.URL.Query()
	allowed := map[string]bool{"provider": true, "model": true, "limit": true, "cursor": true, "history": prices, "from": !prices, "to": !prices, "owner_id": !prices, "state": !prices, "submission_state": !prices}
	add := func(clause string, v any) {
		f.args = append(f.args, v)
		f.where += fmt.Sprintf(" AND "+clause, len(f.args))
	}
	for k, vs := range q {
		if !allowed[k] || len(vs) != 1 {
			return f, bad("invalid_filter", "未知或重复筛选参数")
		}
	}
	for _, k := range []string{"provider", "model", "state", "submission_state"} {
		v := q.Get(k)
		if v == "" {
			continue
		}
		enums := ""
		switch k {
		case "provider":
			enums = "soniox assemblyai"
		case "state":
			enums = "pending running succeeded failed cancelled"
		case "submission_state":
			enums = "prepared sent known uncertain confirmed_absent"
		}
		if enums != "" && !slices.Contains(strings.Fields(enums), v) {
			return f, bad("invalid_filter", "未知调用筛选值")
		}
		if !utf8.ValidString(v) || utf8.RuneCountInString(v) > 200 {
			return f, bad("invalid_filter", "筛选文本过长")
		}
		column := k
		if k == "state" {
			column = "result_state"
		}
		add("e."+column+"=$%d", v)
	}
	if v := q.Get("owner_id"); v != "" {
		if !validID(v) {
			return f, bad("invalid_filter", "ID 格式不正确")
		}
		add("e.owner_id=$%d::uuid", v)
	}
	var from, to time.Time
	for _, k := range []string{"from", "to"} {
		if v := q.Get(k); v != "" {
			t, e := time.Parse(time.RFC3339Nano, v)
			if e != nil {
				return f, bad("invalid_date", "时间格式不正确")
			}
			if k == "from" {
				from = t
				add("e.created_at >= $%d", t)
			} else {
				to = t
				add("e.created_at < $%d", t)
			}
		}
	}
	if !from.IsZero() && !to.IsZero() && !from.Before(to) {
		return f, bad("invalid_date", "起始时间须早于结束时间")
	}
	if v := q.Get("limit"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil || n < 1 || n > 100 {
			return f, bad("invalid_limit", "每页数量须为 1–100")
		}
		f.limit = n
	}
	if v := q.Get("cursor"); v != "" {
		if len(v) > 512 {
			return f, bad("invalid_cursor", "分页游标不正确")
		}
		raw, e := base64.RawURLEncoding.Strict().DecodeString(v)
		var c eventCursor
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		var extra any
		if e != nil || d.Decode(&c) != nil || d.Decode(&extra) != io.EOF || !validID(c.ID) || c.CreatedAt.IsZero() {
			return f, bad("invalid_cursor", "分页游标不正确")
		}
		f.cursor = &c
	}
	if v := q.Get("history"); v != "" {
		if v != "true" && v != "false" {
			return f, bad("invalid_filter", "未知调用筛选值")
		}
		f.history = v == "true"
	}
	return f, nil
}
func (f sttQuery) page() (string, []any) {
	args := append([]any{}, f.args...)
	tail := f.where
	if f.cursor != nil {
		args = append(args, f.cursor.CreatedAt, f.cursor.ID)
		tail += fmt.Sprintf(" AND (e.created_at,e.id)<($%d,$%d::uuid)", len(args)-1, len(args))
	}
	args = append(args, f.limit+1)
	return tail + fmt.Sprintf(" ORDER BY e.created_at DESC,e.id DESC LIMIT $%d", len(args)), args
}
func (a *App) sttPage(w http.ResponseWriter, r *http.Request, sql string, args []any, limit int) error {
	rows, err := a.DB.Query(r.Context(), sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []json.RawMessage{}
	var last eventCursor
	var next *string
	for rows.Next() {
		var raw json.RawMessage
		var c eventCursor
		if err := rows.Scan(&raw, &c.CreatedAt, &c.ID); err != nil {
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
	writeJSON(w, 200, map[string]any{"items": items, "next_cursor": next})
	return nil
}

const sttCallJSON = `jsonb_build_object('id',e.id,'owner_id',e.owner_id,'email',u.email,'operation_id',e.operation_id,'job_id',e.job_id,'transcription_id',e.transcription_id,'provider',e.provider,'model',e.model,'duration_ms',e.duration_ms::text,'diarization',e.diarization,'price_version_id',e.price_version_id,'rate_microusd_per_hour',e.rate_microusd_per_hour::text,'estimated_cost_microusd',e.estimated_cost_microusd::text,'currency',e.currency,'basis',e.basis,'origin',e.origin,'submission_state',e.submission_state,'result_state',e.result_state,'job_attempt',e.job_attempt,'created_at',e.created_at,'updated_at',e.updated_at)`

func (a *App) adminSTTCalls(w http.ResponseWriter, r *http.Request) error {
	f, err := parseSTTQuery(r, false)
	if err != nil {
		return err
	}
	tail, args := f.page()
	return a.sttPage(w, r, `SELECT `+sttCallJSON+`,e.created_at,e.id FROM stt_calls e JOIN users u ON u.id=e.owner_id`+tail, args, f.limit)
}

const sttSummaryJSON = `jsonb_build_object(
 'submitted_count',count(*) FILTER(WHERE origin<>'restore_observation')::text,
 'restored_count',count(*) FILTER(WHERE origin='restore_observation')::text,
 'completed_duration_ms',COALESCE(sum(duration_ms) FILTER(WHERE submission_state='known' AND result_state='succeeded'),0)::text,
 'completed_estimated_cost_microusd',COALESCE(sum(estimated_cost_microusd) FILTER(WHERE submission_state='known' AND result_state='succeeded'),0)::text,
 'pending_estimated_cost_microusd',COALESCE(sum(estimated_cost_microusd) FILTER(WHERE submission_state='known' AND result_state IN ('pending','running')),0)::text,
 'uncertain_count',count(*) FILTER(WHERE submission_state IN ('sent','uncertain'))::text,
 'unpriced_count',count(*) FILTER(WHERE price_version_id IS NULL)::text)`

func (a *App) adminSTTSummary(w http.ResponseWriter, r *http.Request) error {
	f, err := parseSTTQuery(r, false)
	if err != nil {
		return err
	}
	// One statement gives totals and confirmation groups the identical database snapshot.
	var raw json.RawMessage
	err = a.DB.QueryRow(r.Context(), `WITH filtered AS (SELECT e.* FROM stt_calls e`+f.where+`), groups AS (
 SELECT submission_state,`+sttSummaryJSON+` AS stats FROM filtered GROUP BY submission_state)
 SELECT jsonb_build_object('currency','USD','totals',(SELECT `+sttSummaryJSON+` FROM filtered),
 'by_submission_state',COALESCE((SELECT jsonb_agg(jsonb_build_object('submission_state',submission_state,'stats',stats) ORDER BY submission_state) FROM groups),'[]'::jsonb))`, f.args...).Scan(&raw)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

const sttPriceJSON = `jsonb_build_object('id',e.id,'provider',e.provider,'model',e.model,'currency',e.currency,'hourly_rate_microusd',e.hourly_rate_microusd::text,'diarization_hourly_rate_microusd',e.diarization_hourly_rate_microusd::text,'basis',e.basis,'source',e.source,'verified_on',to_char(e.verified_on,'YYYY-MM-DD'),'created_by',e.created_by,'created_at',e.created_at)`

func (a *App) adminSTTPrices(w http.ResponseWriter, r *http.Request) error {
	f, err := parseSTTQuery(r, true)
	if err != nil {
		return err
	}
	tail, args := f.page()
	table := "stt_price_versions"
	if !f.history {
		table = "(SELECT DISTINCT ON (provider,model) * FROM stt_price_versions ORDER BY provider,model,created_at DESC,id DESC)"
	}
	return a.sttPage(w, r, `SELECT `+sttPriceJSON+`,e.created_at,e.id FROM `+table+` e`+tail, args, f.limit)
}

// rejectManualSTTPrice retires the write API without replaying old successful requests.
func (a *App) rejectManualSTTPrice(w http.ResponseWriter, r *http.Request) error {
	return &apiError{http.StatusForbidden, "manual_pricing_disabled", "不允许手动管理模型价格"}
}
