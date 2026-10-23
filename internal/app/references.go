// @concord-file
// @concord-implements docs/feature/sentence-links/use-case/copy-sentence-link.md
package app

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
)

type transcriptReference struct {
	Code            string            `json:"code"`
	RecordingID     string            `json:"recording_id"`
	TranscriptionID string            `json:"transcription_id"`
	Segments        []json.RawMessage `json:"segments"`
}

var referenceCode = regexp.MustCompile(`^[A-Za-z0-9_-]{12}$`)

func (a *App) createReference(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		SegmentIDs []string `json:"segment_ids"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	invalid := func() error {
		return bad("invalid_reference", "请选择同一转写版本的 1–100 个不同片段。")
	}
	if len(in.SegmentIDs) < 1 || len(in.SegmentIDs) > 100 {
		return invalid()
	}
	seen := make(map[string]bool, len(in.SegmentIDs))
	for i, value := range in.SegmentIDs {
		id, err := uuid.Parse(value)
		if err != nil || seen[id.String()] {
			return invalid()
		}
		in.SegmentIDs[i] = id.String()
		seen[id.String()] = true
	}
	out := transcriptReference{TranscriptionID: r.PathValue("id")}
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		// The route's ownership gate precedes this lock; ownership is immutable.
		if err := lockTranscription(r.Context(), tx, out.TranscriptionID); err != nil {
			return err
		}
		items, err := many(r.Context(), tx, "SELECT "+segmentColumns+segmentJoins+" WHERE s.transcription_id=$1 AND s.id=ANY($2::uuid[]) AND r.owner_id=$3 AND r.state<>'deleting' ORDER BY s.ordinal", out.TranscriptionID, in.SegmentIDs, persistence.UserID(r.Context()))
		if err != nil {
			return err
		}
		if len(items) != len(in.SegmentIDs) {
			return invalid()
		}
		ids := make([]string, len(items))
		for i, item := range items {
			var segment struct {
				ID          string `json:"id"`
				RecordingID string `json:"recording_id"`
			}
			if err := json.Unmarshal(item, &segment); err != nil {
				return err
			}
			ids[i], out.RecordingID = segment.ID, segment.RecordingID
		}
		out.Segments = items
		for range 5 {
			var random [9]byte
			if _, err := rand.Read(random[:]); err != nil {
				return err
			}
			out.Code = base64.RawURLEncoding.EncodeToString(random[:])
			tag, err := tx.Exec(r.Context(), "INSERT INTO transcript_references(code,transcription_id,segment_ids) VALUES($1,$2,$3::uuid[]) ON CONFLICT(code) DO NOTHING", out.Code, out.TranscriptionID, ids)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 1 {
				return nil
			}
		}
		return fmt.Errorf("could not allocate reference code")
	})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, out)
	return nil
}

func (a *App) getReference(w http.ResponseWriter, r *http.Request) error {
	code := r.PathValue("code")
	if !referenceCode.MatchString(code) {
		return notFound()
	}
	out := transcriptReference{Code: code}
	var ids []string
	// {code} deliberately has its own owner guard: it is not a UUID or a credential.
	err := a.DB.QueryRow(r.Context(), `SELECT q.transcription_id,r.id,q.segment_ids::text[]
	 FROM transcript_references q JOIN transcriptions t ON t.id=q.transcription_id
	 JOIN recordings r ON r.id=t.recording_id
	 WHERE q.code=$1 AND q.owner_id=$2 AND r.owner_id=$2 AND r.state<>'deleting'`, code, persistence.UserID(r.Context())).Scan(&out.TranscriptionID, &out.RecordingID, &ids)
	if err != nil {
		return err
	}
	out.Segments, err = many(r.Context(), a.DB, "SELECT "+segmentColumns+segmentJoins+" WHERE s.transcription_id=$1 AND s.id=ANY($2::uuid[]) AND r.owner_id=$3 AND r.state<>'deleting' ORDER BY s.ordinal", out.TranscriptionID, ids, persistence.UserID(r.Context()))
	if err != nil {
		return err
	}
	if len(out.Segments) != len(ids) {
		return notFound()
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}
