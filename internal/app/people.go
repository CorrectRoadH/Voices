package app

import (
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strings"
	"voices/internal/persistence"
)

func (a *App) listPeople(w http.ResponseWriter, r *http.Request) error {
	limit, offset, err := paging(r)
	if err != nil {
		return err
	}
	archived := r.URL.Query().Get("archived")
	items, err := many(r.Context(), a.DB, "SELECT "+personColumns+" FROM people p WHERE p.owner_id=$6 AND ($7 OR p.builtin_key IS NULL) AND ($1='' OR p.display_name ILIKE $2) AND ($3='all' OR (p.archived_at IS NOT NULL)=($3='true')) ORDER BY (p.builtin_key IS NULL),p.display_name,p.id LIMIT $4 OFFSET $5", r.URL.Query().Get("q"), ilike(r.URL.Query().Get("q")), archived, limit+1, offset, persistence.UserID(r.Context()), r.URL.Query().Get("include_builtin") == "true")
	if err != nil {
		return err
	}
	page(w, items, limit, offset)
	return nil
}
func (a *App) getPerson(w http.ResponseWriter, r *http.Request) error {
	item, err := one(r.Context(), a.DB, "SELECT "+personColumns+" FROM people p WHERE id=$1", r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, 200, item)
	return nil
}
func (a *App) createPerson(w http.ResponseWriter, r *http.Request) error {
	key, err := requestKey(r)
	if err != nil {
		return err
	}
	var in struct {
		DisplayName string  `json:"display_name"`
		Notes       string  `json:"notes"`
		AvatarData  *string `json:"avatar_data"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	if in.DisplayName == "" || len([]rune(in.DisplayName)) > 200 || len(in.Notes) > 100000 {
		return bad("invalid_person", "请输入有效的人物名称与备注")
	}
	avatar, err := normalizeAvatar(in.AvatarData)
	if err != nil {
		return err
	}
	id := uuid.NewString()
	hash := digest(jsonBytes(in))
	existing := false
	err = persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		old, err := claimKey(r.Context(), tx, "person", key, hash)
		if err != nil {
			return err
		}
		if old != "" {
			id = old
			existing = true
			return nil
		}
		if _, err := tx.Exec(r.Context(), "INSERT INTO people(id,display_name,notes,owner_id,avatar_png,avatar_revision) VALUES($1,$2,$3,$4,$5,CASE WHEN $5::bytea IS NULL THEN 0 ELSE 1 END)", id, in.DisplayName, in.Notes, persistence.UserID(r.Context()), avatar); err != nil {
			return err
		}
		return saveKey(r.Context(), tx, "person", key, hash, id)
	})
	if err != nil {
		return err
	}
	item, err := one(r.Context(), a.DB, "SELECT "+personColumns+" FROM people p WHERE id=$1", id)
	if err != nil {
		return err
	}
	status := 201
	if existing {
		status = 200
	}
	writeJSON(w, status, item)
	return nil
}
func (a *App) patchPerson(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Revision    int64            `json:"revision"`
		DisplayName *string          `json:"display_name"`
		Notes       *string          `json:"notes"`
		Archived    *bool            `json:"archived"`
		IsSelf      *bool            `json:"is_self"`
		AvatarData  Optional[string] `json:"avatar_data"`
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
			return bad("invalid_name", "人物名称须为 1–200 字")
		}
	}
	if in.Notes != nil && len(*in.Notes) > 100000 {
		return bad("invalid_notes", "备注过长")
	}
	avatar, err := normalizeAvatar(in.AvatarData.Value)
	if err != nil {
		return err
	}
	var builtin *string
	if err := a.DB.QueryRow(r.Context(), "SELECT builtin_key FROM people WHERE id=$1", r.PathValue("id")).Scan(&builtin); err != nil {
		return err
	}
	if builtin != nil {
		return bad("builtin_person_readonly", "内置人物不可修改或归档")
	}
	err = persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "self-person:"+persistence.UserID(r.Context())); err != nil {
			return err
		}
		if in.IsSelf != nil && *in.IsSelf {
			if _, err := tx.Exec(r.Context(), "UPDATE people SET is_self=false,revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND is_self AND id<>$2", persistence.UserID(r.Context()), r.PathValue("id")); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(r.Context(), "UPDATE people SET display_name=COALESCE($3,display_name),notes=COALESCE($4,notes),archived_at=CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN COALESCE(archived_at,clock_timestamp()) ELSE NULL END,is_self=COALESCE($6,is_self),avatar_png=CASE WHEN $7 THEN $8::bytea ELSE avatar_png END,avatar_revision=avatar_revision+CASE WHEN $7 THEN 1 ELSE 0 END,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2", r.PathValue("id"), in.Revision, in.DisplayName, in.Notes, in.Archived, in.IsSelf, in.AvatarData.Present, avatar)
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
	return a.getPerson(w, r)
}
