package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
)

func (a *App) getSegment(w http.ResponseWriter, r *http.Request) error {
	item, err := one(r.Context(), a.DB, "SELECT "+segmentColumns+segmentJoins+" WHERE s.id=$1 AND r.state<>'deleting'", r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, 200, item)
	return nil
}
func (a *App) listSegments(w http.ResponseWriter, r *http.Request) error {
	limit, offset, err := paging(r)
	if err != nil {
		return err
	}
	tid := r.PathValue("id")
	hideBuiltin := r.URL.Query().Get("hide_builtin") == "true"
	var exists bool
	if err := a.DB.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM transcriptions t JOIN recordings r ON r.id=t.recording_id WHERE t.id=$1 AND r.state<>'deleting')", tid).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return notFound()
	}
	if anchor := r.URL.Query().Get("anchor_id"); anchor != "" {
		var ordinal int
		if err := a.DB.QueryRow(r.Context(), "SELECT ordinal FROM segments WHERE id=$1 AND transcription_id=$2", anchor, tid).Scan(&ordinal); err != nil {
			return err
		}
		var preceding int
		if err := a.DB.QueryRow(r.Context(), "SELECT count(*)"+segmentJoins+" WHERE s.transcription_id=$1 AND s.ordinal<$2 AND (NOT $3 OR p.builtin_key IS NULL)", tid, ordinal, hideBuiltin).Scan(&preceding); err != nil {
			return err
		}
		offset = max(0, preceding-limit/2)
	}
	items, err := many(r.Context(), a.DB, "SELECT "+segmentColumns+segmentJoins+" WHERE s.transcription_id=$1 AND r.state<>'deleting' AND (NOT $4 OR p.builtin_key IS NULL) ORDER BY s.ordinal LIMIT $2 OFFSET $3", tid, limit+1, offset, hideBuiltin)
	if err != nil {
		return err
	}
	var next, previous *string
	if len(items) > limit {
		items = items[:limit]
		c := cursor(offset + limit)
		next = &c
	}
	if offset > 0 {
		c := cursor(max(0, offset-limit))
		previous = &c
	}
	writeJSON(w, 200, map[string]any{"items": items, "next_cursor": next, "previous_cursor": previous, "current_cursor": cursor(offset)})
	return nil
}
func (a *App) patchSegment(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Revision        int64            `json:"revision"`
		EditedText      Optional[string] `json:"edited_text"`
		StartMS         Optional[int64]  `json:"start_ms"`
		EndMS           Optional[int64]  `json:"end_ms"`
		AssignmentMode  *string          `json:"assignment_mode"`
		AssignedLabelID Optional[string] `json:"assigned_label_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Revision < 1 {
		return bad("revision_required", "缺少版本号")
	}
	if in.EditedText.Value != nil && len(*in.EditedText.Value) > 100000 {
		return bad("text_too_long", "片段文字过长")
	}
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		var tid string
		if err := tx.QueryRow(r.Context(), "SELECT transcription_id FROM segments WHERE id=$1", r.PathValue("id")).Scan(&tid); err != nil {
			return err
		}
		if err := lockTranscription(r.Context(), tx, tid); err != nil {
			return err
		}
		var start, end *int64
		var mode string
		var label *string
		var revision int64
		var duration int64
		if err := tx.QueryRow(r.Context(), "SELECT s.start_ms,s.end_ms,s.assignment_mode,s.assigned_label_id,s.revision,r.duration_ms FROM segments s JOIN transcriptions t ON t.id=s.transcription_id JOIN recordings r ON r.id=t.recording_id WHERE s.id=$1 FOR UPDATE OF s", r.PathValue("id")).Scan(&start, &end, &mode, &label, &revision, &duration); err != nil {
			return err
		}
		if revision != in.Revision {
			return conflict()
		}
		if in.StartMS.Present {
			start = in.StartMS.Value
		}
		if in.EndMS.Present {
			end = in.EndMS.Value
		}
		if (start == nil) != (end == nil) || start != nil && (*start < 0 || *end < *start || *end > duration) {
			return bad("invalid_timestamps", "时间须成对设置，且位于录音时长以内")
		}
		if in.AssignmentMode != nil {
			mode = *in.AssignmentMode
		}
		if in.AssignedLabelID.Present {
			label = in.AssignedLabelID.Value
		}
		if mode != "inherit" && mode != "label" && mode != "unknown" {
			return bad("invalid_assignment", "说话人分配模式不正确")
		}
		if mode != "label" {
			label = nil
		} else if label == nil {
			return bad("label_required", "请选择说话人标签")
		}
		_, err := tx.Exec(r.Context(), "UPDATE segments SET edited_text=CASE WHEN $2 THEN $3::text ELSE edited_text END,start_ms=$4,end_ms=$5,assignment_mode=$6,assigned_label_id=$7,revision=revision+1 WHERE id=$1", r.PathValue("id"), in.EditedText.Present, in.EditedText.Value, start, end, mode, label)
		return err
	})
	if err != nil {
		return err
	}
	return a.getSegment(w, r)
}
func (a *App) exportTranscription(w http.ResponseWriter, r *http.Request) error {
	var state string
	if err := a.DB.QueryRow(r.Context(), "SELECT t.state FROM transcriptions t JOIN recordings r ON r.id=t.recording_id WHERE t.id=$1 AND r.state<>'deleting'", r.PathValue("id")).Scan(&state); err != nil {
		return err
	}
	if state != "succeeded" {
		return &apiError{409, "not_completed", "版本尚未完成"}
	}
	format := r.URL.Query().Get("format")
	if format != "txt" && format != "srt" && format != "json" {
		return bad("invalid_format", "导出格式须为 txt、srt 或 json")
	}
	if format == "srt" {
		var invalid bool
		if err := a.DB.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM segments WHERE transcription_id=$1 AND (start_ms IS NULL OR end_ms IS NULL))", r.PathValue("id")).Scan(&invalid); err != nil {
			return err
		}
		if invalid {
			return &apiError{422, "timestamps_required", "存在无时间戳片段，不能导出 SRT"}
		}
	}
	// One bounded database page at a time; export never loads the whole transcript.
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="transcription-%s.%s"`, r.PathValue("id"), format))
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if format == "json" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		fmt.Fprint(w, "[")
	}
	offset := 0
	for {
		items, err := many(r.Context(), a.DB, "SELECT "+segmentColumns+segmentJoins+" WHERE s.transcription_id=$1 AND r.state<>'deleting' ORDER BY s.ordinal LIMIT 100 OFFSET $2", r.PathValue("id"), offset)
		if err != nil {
			return err
		}
		for i, raw := range items {
			var s struct {
				Text           string `json:"text"`
				Speaker        string `json:"speaker_name"`
				StartMS, EndMS *int64
			}
			var data map[string]json.RawMessage
			json.Unmarshal(raw, &data)
			json.Unmarshal(raw, &s)
			json.Unmarshal(data["start_ms"], &s.StartMS)
			json.Unmarshal(data["end_ms"], &s.EndMS)
			switch format {
			case "json":
				if offset+i > 0 {
					fmt.Fprint(w, ",")
				}
				w.Write(raw)
			case "txt":
				fmt.Fprintf(w, "%s: %s\n", s.Speaker, s.Text)
			case "srt":
				if s.StartMS == nil || s.EndMS == nil {
					return nil
				}
				fmt.Fprintf(w, "%d\n%s --> %s\n%s: %s\n\n", offset+i+1, srtTime(*s.StartMS), srtTime(*s.EndMS), s.Speaker, strings.ReplaceAll(s.Text, "\r", ""))
			}
		}
		offset += len(items)
		if len(items) < 100 {
			break
		}
	}
	if format == "json" {
		fmt.Fprint(w, "]\n")
	}
	return nil
}
func srtTime(ms int64) string {
	return fmt.Sprintf("%02d:%02d:%02d,%03d", ms/3600000, (ms/60000)%60, (ms/1000)%60, ms%1000)
}
