package app

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
	"voices/internal/persistence"
)

// authorizeResource is the mandatory gate for every business route with an ID.
// Ownership is immutable, including while the handler executes its transaction.
func (a *App) authorizeResource(r *http.Request) error {
	if r.PathValue("id") == "" {
		return nil
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 4 {
		return notFound()
	}
	tables := map[string]string{"recordings": "recordings", "people": "people", "transcriptions": "transcriptions", "segments": "segments", "speaker-labels": "speaker_labels", "jobs": "jobs"}
	table, ok := tables[parts[2]]
	if !ok {
		return &apiError{500, "missing_ownership_guard", "资源权限检查未配置"}
	}
	if _, err := uuid.Parse(r.PathValue("id")); err != nil {
		return notFound()
	}
	var exists bool
	if err := a.DB.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM "+table+" WHERE id=$1 AND owner_id=$2)", r.PathValue("id"), persistence.UserID(r.Context())).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return notFound()
	}
	return nil
}
func (a *App) updateMe(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		DisplayName string  `json:"display_name"`
		Username    *string `json:"username"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	if len([]rune(in.DisplayName)) < 1 || len([]rune(in.DisplayName)) > 100 {
		return bad("invalid_name", "显示名称须为 1–100 字")
	}
	if in.Username != nil {
		*in.Username = normalizeEmail(*in.Username)
		if !validUsername(*in.Username) {
			return bad("invalid_username", "用户名须为 2–32 个字母、数字或下划线")
		}
	}
	u := currentUser(r.Context())
	if _, err := a.DB.Exec(r.Context(), "UPDATE users SET display_name=$2,username=CASE WHEN $3::text IS NULL THEN username ELSE NULLIF($3,'') END,updated_at=clock_timestamp() WHERE id=$1", u.ID, in.DisplayName, in.Username); err != nil {
		return err
	}
	u.DisplayName = in.DisplayName
	if in.Username != nil {
		u.Username = *in.Username
	}
	writeJSON(w, 200, u)
	return nil
}
func (a *App) changePassword(w http.ResponseWriter, r *http.Request) error {
	if err := a.rateLimit(r, "password_change", persistence.UserID(r.Context()), 10); err != nil {
		return err
	}
	var in struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := validPassword(in.New); err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.New), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	err = persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		var old string
		if err := tx.QueryRow(r.Context(), "SELECT password_hash FROM users WHERE id=$1 FOR UPDATE", persistence.UserID(r.Context())).Scan(&old); err != nil {
			return err
		}
		if bcrypt.CompareHashAndPassword([]byte(old), []byte(in.Current)) != nil {
			return &apiError{403, "invalid_credentials", "当前密码不正确"}
		}
		if _, err := tx.Exec(r.Context(), "UPDATE users SET password_hash=$2,updated_at=clock_timestamp() WHERE id=$1", persistence.UserID(r.Context()), string(hash)); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), "DELETE FROM sessions WHERE user_id=$1", persistence.UserID(r.Context()))
		return err
	})
	if err != nil {
		return err
	}
	a.clearSessionCookies(w)
	w.WriteHeader(204)
	return nil
}

// ResetPassword is a local operator-only recovery action. It never changes roles.
func (a *App) ResetPassword(ctx context.Context, email, password string) error {
	if err := validPassword(password); err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	return persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, "UPDATE users SET password_hash=$2,updated_at=clock_timestamp() WHERE email=$1 RETURNING id", normalizeEmail(email), string(hash)).Scan(&id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", id); err != nil {
			return err
		}
		return audit(ctx, tx, nil, id, "password_reset", map[string]any{})
	})
}
func audit(ctx context.Context, tx pgx.Tx, actor, target any, action string, details any) error {
	_, err := tx.Exec(ctx, "INSERT INTO admin_audit_events(id,actor_id,target_user_id,action,details) VALUES($1,$2,$3,$4,$5)", uuid.NewString(), actor, target, action, jsonBytes(details))
	return err
}
func requireAdmin(r *http.Request) error {
	if currentUser(r.Context()).Role != "admin" {
		return &apiError{403, "admin_required", "需要管理员权限"}
	}
	return nil
}
func lockAdmin(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, "SELECT id FROM instance_settings WHERE id=1 FOR UPDATE"); err != nil {
		return err
	}
	var valid bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND role='admin' AND status='active')", persistence.UserID(ctx)).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return &apiError{403, "admin_required", "需要管理员权限"}
	}
	return nil
}
func (a *App) adminUsers(w http.ResponseWriter, r *http.Request) error {
	limit, offset, err := paging(r)
	if err != nil {
		return err
	}
	items, err := many(r.Context(), a.DB, "SELECT id,email,COALESCE(username,'') AS username,display_name,role,status,created_at FROM users ORDER BY created_at,id LIMIT $1 OFFSET $2", limit+1, offset)
	if err != nil {
		return err
	}
	page(w, items, limit, offset)
	return nil
}
func (a *App) adminUpdateUser(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Role   *string `json:"role"`
		Status *string `json:"status"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Role == nil && in.Status == nil {
		return bad("invalid_request", "请选择角色或状态")
	}
	if in.Role != nil && *in.Role != "admin" && *in.Role != "user" {
		return bad("invalid_role", "角色不正确")
	}
	if in.Status != nil && *in.Status != "active" && *in.Status != "disabled" {
		return bad("invalid_status", "状态不正确")
	}
	var u User
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		if err := lockAdmin(r.Context(), tx); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), "SELECT id,email,COALESCE(username,''),display_name,role,status FROM users WHERE id=$1 FOR UPDATE", r.PathValue("id")).Scan(&u.ID, &u.Email, &u.Username, &u.DisplayName, &u.Role, &u.Status); err != nil {
			return err
		}
		oldRole, oldStatus := u.Role, u.Status
		if in.Role != nil {
			u.Role = *in.Role
		}
		if in.Status != nil {
			u.Status = *in.Status
		}
		if oldRole == "admin" && oldStatus == "active" && (u.Role != "admin" || u.Status != "active") {
			var count int
			if err := tx.QueryRow(r.Context(), "SELECT count(*) FROM users WHERE role='admin' AND status='active'").Scan(&count); err != nil {
				return err
			}
			if count <= 1 {
				return &apiError{409, "last_admin", "不能停用或降级最后一个有效管理员"}
			}
		}
		if _, err := tx.Exec(r.Context(), "UPDATE users SET role=$2,status=$3,updated_at=clock_timestamp() WHERE id=$1", u.ID, u.Role, u.Status); err != nil {
			return err
		}
		if u.Status == "disabled" {
			if _, err := tx.Exec(r.Context(), "DELETE FROM sessions WHERE user_id=$1", u.ID); err != nil {
				return err
			}
		}
		return audit(r.Context(), tx, persistence.UserID(r.Context()), u.ID, "account_updated", map[string]any{"old_role": oldRole, "role": u.Role, "old_status": oldStatus, "status": u.Status})
	})
	if err != nil {
		return err
	}
	writeJSON(w, 200, u)
	return nil
}
func (a *App) adminRegistration(w http.ResponseWriter, r *http.Request) error {
	var open bool
	if r.Method == "PATCH" {
		var in struct {
			Open *bool `json:"registration_open"`
		}
		if err := decode(r, &in); err != nil {
			return err
		}
		if in.Open == nil {
			return bad("invalid_request", "缺少注册开关")
		}
		open = *in.Open
		if err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
			if err := lockAdmin(r.Context(), tx); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), "UPDATE instance_settings SET registration_open=$1 WHERE id=1", open); err != nil {
				return err
			}
			return audit(r.Context(), tx, persistence.UserID(r.Context()), nil, "registration_updated", map[string]bool{"registration_open": open})
		}); err != nil {
			return err
		}
	} else {
		if err := a.DB.QueryRow(r.Context(), "SELECT registration_open FROM instance_settings WHERE id=1").Scan(&open); err != nil {
			return err
		}
	}
	writeJSON(w, 200, map[string]bool{"registration_open": open})
	return nil
}
