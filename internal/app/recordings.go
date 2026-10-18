package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
	"voices/internal/providers"
)

func (a *App) listRecordings(w http.ResponseWriter, r *http.Request) error {
	limit, offset, err := paging(r)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	var from, to any
	if v := q.Get("from"); v != "" {
		d, e := time.Parse("2006-01-02", v)
		if e != nil {
			return bad("invalid_date", "开始日期不正确")
		}
		from = d
	}
	if v := q.Get("to"); v != "" {
		d, e := time.Parse("2006-01-02", v)
		if e != nil {
			return bad("invalid_date", "结束日期不正确")
		}
		to = d.AddDate(0, 0, 1)
	}
	var person any
	if q.Get("person_id") != "" {
		person = q.Get("person_id")
	}
	items, err := many(r.Context(), a.DB, `SELECT `+recordingColumns+` FROM recordings r WHERE r.owner_id=$9 AND r.state<>'deleting' AND ($1='' OR r.title ILIKE $2 OR EXISTS(SELECT 1 FROM segments s WHERE s.transcription_id=r.active_transcription_id AND COALESCE(s.edited_text,s.source_text) ILIKE $2)) AND ($3::timestamptz IS NULL OR r.recorded_at >= $3) AND ($4::timestamptz IS NULL OR r.recorded_at < $4) AND ($5='' OR r.state=$5) AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM segments s JOIN speaker_labels l ON l.id=CASE s.assignment_mode WHEN 'inherit' THEN s.source_speaker_label_id WHEN 'label' THEN s.assigned_label_id END WHERE s.transcription_id=r.active_transcription_id AND l.person_id=$6)) ORDER BY r.recorded_at DESC,r.id LIMIT $7 OFFSET $8`, q.Get("q"), ilike(q.Get("q")), from, to, q.Get("state"), person, limit+1, offset, persistence.UserID(r.Context()))
	if err != nil {
		return err
	}
	page(w, items, limit, offset)
	return nil
}
func (a *App) recording(ctx context.Context, id string) (json.RawMessage, error) {
	return one(ctx, a.DB, "SELECT "+recordingColumns+" FROM recordings r WHERE id=$1 AND owner_id=$2 AND state<>'deleting'", id, persistence.UserID(ctx))
}
func (a *App) getRecording(w http.ResponseWriter, r *http.Request) error {
	item, err := a.recording(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, 200, item)
	return nil
}

type importMetadata struct {
	Title          string             `json:"title"`
	RecordedAt     *time.Time         `json:"recorded_at"`
	Notes          string             `json:"notes"`
	AutoTranscribe bool               `json:"auto_transcribe"`
	Options        *providers.Options `json:"transcription_options"`
}

func (a *App) uploadRecording(w http.ResponseWriter, r *http.Request) error {
	key, err := requestKey(r)
	if err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, a.Config.MaxUploadBytes+(1<<20))
	reader, err := r.MultipartReader()
	if err != nil {
		return bad("invalid_upload", "请上传 multipart 音频文件")
	}
	metaPart, err := reader.NextPart()
	if err != nil || metaPart.FormName() != "metadata" {
		return bad("metadata_required", "上传元数据必须位于文件之前")
	}
	var meta importMetadata
	decoder := json.NewDecoder(io.LimitReader(metaPart, 65537))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&meta); err != nil {
		return bad("invalid_metadata", "上传元数据格式不正确")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return bad("invalid_metadata", "上传元数据格式不正确")
	}
	metaPart.Close()
	if len(meta.Title) > 1000 || len(meta.Notes) > 100000 {
		return bad("invalid_metadata", "标题或备注过长")
	}
	if meta.AutoTranscribe {
		if a.Config.RestoreMode {
			return &apiError{409, "restore_mode", "恢复核对期间不能启动转写"}
		}
		if meta.Options == nil {
			s, e := a.readSettings(r)
			if e != nil {
				return e
			}
			meta.Options = s.DefaultTranscription
		}
		if meta.Options == nil {
			return bad("options_required", "自动转写需要选择语言与模型")
		}
		if _, err := a.validateOptions(*meta.Options, 0, 0); err != nil {
			return err
		}
	} else {
		meta.Options = nil
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "file" || part.FileName() == "" {
		return bad("file_required", "缺少音频文件")
	}
	name := filepath.Base(strings.ReplaceAll(part.FileName(), "\\", "/"))
	if len(name) > 1000 {
		return bad("invalid_filename", "文件名过长")
	}
	tmp, err := os.CreateTemp(a.Config.TempDir, "voices-import-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	writer, err := a.Blobs.NewWriter(r.Context(), "", nil)
	if err != nil {
		return err
	}
	defer writer.Close()
	if err := writer.WriteFrom(r.Context(), part, tmp, a.Config.MaxUploadBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) || strings.Contains(err.Error(), "size limit") {
			return &apiError{413, "file_too_large", "音频超过文件大小限制"}
		}
		return err
	}
	part.Close()
	if _, err := reader.NextPart(); err != io.EOF {
		return bad("unexpected_part", "每次请求只能上传一个文件")
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	info, err := probe(r.Context(), tmp.Name())
	if err != nil {
		return err
	}
	if meta.Options != nil {
		if _, err := a.validateOptions(*meta.Options, info.DurationMS, writer.Size); err != nil {
			return err
		}
	}
	hash := digest(append(jsonBytes(meta), []byte("\x00"+writer.Digest)...))
	id := uuid.NewString()
	existing := false
	err = persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		old, err := claimKey(r.Context(), tx, "recording", key, hash)
		if err != nil {
			return err
		}
		if old != "" {
			id = old
			existing = true
			return nil
		}
		// The digest advisory lock orders identical imports; UNIQUE(sha256) remains the final authority.
		if _, err := tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1,1))", persistence.UserID(r.Context())+":"+writer.Digest); err != nil {
			return err
		}
		var state string
		err = tx.QueryRow(r.Context(), "SELECT id,state FROM recordings WHERE sha256=$1 AND owner_id=$2 FOR UPDATE", writer.Digest, persistence.UserID(r.Context())).Scan(&old, &state)
		if err == nil {
			if state == "deleting" {
				return conflict()
			}
			id = old
			existing = true
			return saveKey(r.Context(), tx, "recording", key, hash, id)
		}
		if err != pgx.ErrNoRows {
			return err
		}
		title := strings.TrimSpace(meta.Title)
		if title == "" {
			title = strings.TrimSuffix(name, filepath.Ext(name))
		}
		date := time.Now().UTC()
		source := "import"
		if meta.RecordedAt != nil {
			date = *meta.RecordedAt
			source = "user"
		}
		var options any
		if meta.Options != nil {
			options = jsonBytes(meta.Options)
		}
		if _, err := tx.Exec(r.Context(), `INSERT INTO recordings(id,sha256,title,original_name,recorded_at,recorded_at_source,notes,duration_ms,size_bytes,mime_type,state,auto_transcribe,import_transcription_options,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'preparing',$11,$12,$13)`, id, writer.Digest, title, name, date, source, meta.Notes, info.DurationMS, writer.Size, info.MIME, meta.AutoTranscribe, options, persistence.UserID(r.Context())); err != nil {
			return err
		}
		if err := writer.Publish(r.Context(), tx); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), "INSERT INTO media_assets(id,recording_id,kind,blob_id) VALUES($1,$2,'original',$3)", uuid.NewString(), id, writer.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), "INSERT INTO jobs(id,kind,recording_id,dedupe_key,stage,state) VALUES($1,'prepare',$2,$3,'preparing','queued')", uuid.NewString(), id, "prepare:"+id); err != nil {
			return err
		}
		return saveKey(r.Context(), tx, "recording", key, hash, id)
	})
	if err != nil {
		return err
	}
	item, err := a.recording(r.Context(), id)
	if err != nil {
		return err
	}
	status := 201
	if existing {
		status = 200
	}
	writeJSON(w, status, map[string]any{"recording": item, "existing": existing})
	return nil
}
func (a *App) patchRecording(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Revision   int64      `json:"revision"`
		Title      *string    `json:"title"`
		RecordedAt *time.Time `json:"recorded_at"`
		Notes      *string    `json:"notes"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Revision < 1 {
		return bad("revision_required", "缺少版本号")
	}
	if in.Title != nil {
		*in.Title = strings.TrimSpace(*in.Title)
		if *in.Title == "" || len(*in.Title) > 1000 {
			return bad("invalid_title", "标题为空或过长")
		}
	}
	if in.Notes != nil && len(*in.Notes) > 100000 {
		return bad("invalid_notes", "备注过长")
	}
	tag, err := a.DB.Exec(r.Context(), "UPDATE recordings SET title=COALESCE($3,title),recorded_at=COALESCE($4,recorded_at),recorded_at_source=CASE WHEN $4::timestamptz IS NULL THEN recorded_at_source ELSE 'user' END,notes=COALESCE($5,notes),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND state<>'deleting'", r.PathValue("id"), in.Revision, in.Title, in.RecordedAt, in.Notes)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return conflict()
	}
	return a.getRecording(w, r)
}
func (a *App) deleteRecording(w http.ResponseWriter, r *http.Request) error {
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), "UPDATE recordings SET state='deleting',deleted_at=clock_timestamp(),active_transcription_id=NULL,revision=revision+1 WHERE id=$1", r.PathValue("id"))
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return notFound()
		}
		// Hold/uncertain jobs keep their state so operators can still reconcile them.
		_, err = tx.Exec(r.Context(), "UPDATE jobs SET cancel_requested=true,state=CASE WHEN state IN ('uncertain','restore_hold') THEN state ELSE 'cancelled' END,lease_generation=lease_generation+1,lease_owner=NULL,lease_until=NULL WHERE recording_id=$1", r.PathValue("id"))
		return err
	})
	if err != nil {
		return err
	}
	writeJSON(w, 202, map[string]string{"state": "deleting"})
	return nil
}
func (a *App) audio(w http.ResponseWriter, r *http.Request) error {
	var blob string
	var date time.Time
	err := a.DB.QueryRow(r.Context(), "SELECT m.blob_id,r.created_at FROM recordings r JOIN media_assets m ON m.recording_id=r.id AND m.kind='playback' WHERE r.id=$1 AND r.state='ready'", r.PathValue("id")).Scan(&blob, &date)
	if err != nil {
		return err
	}
	reader, err := a.Blobs.Open(r.Context(), r.PathValue("id"), blob)
	if err != nil {
		return err
	}
	defer reader.Close()
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Cache-Control", "private, no-store")
	if strings.Contains(r.Header.Get("Range"), ",") {
		r = r.Clone(r.Context())
		r.Header = r.Header.Clone()
		r.Header.Del("Range")
	}
	http.ServeContent(w, r, "audio.mp3", date, reader)
	return nil
}
