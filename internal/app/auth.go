package app

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
	"voices/internal/persistence"
)

type User struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	Status      string `json:"status"`
	UILanguage  string `json:"ui_language"`
}
type userKey struct{}

func currentUser(ctx context.Context) User { u, _ := ctx.Value(userKey{}).(User); return u }

func validUsername(value string) bool {
	if value == "" {
		return true
	}
	if len([]rune(value)) < 2 || len([]rune(value)) > 32 {
		return false
	}
	for _, r := range value {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' {
			return false
		}
	}
	return true
}

func validEmail(email string) bool {
	if len(email) > 254 || strings.ContainsAny(email, " \t\r\n") {
		return false
	}
	parsed, err := mail.ParseAddress(email)
	return err == nil && parsed.Address == email && strings.Count(email, "@") == 1
}

// Valid bcrypt hash used for nonexistent users so the expensive comparison still runs.
var dummyPasswordHash, _ = bcrypt.GenerateFromPassword([]byte("unused-account-placeholder"), bcrypt.DefaultCost)

func (a *App) cookiePath() string {
	u, _ := url.Parse(a.Config.PublicBaseURL)
	return strings.TrimRight(u.Path, "/") + "/"
}
func (a *App) origin(r *http.Request) error {
	base, _ := url.Parse(a.Config.PublicBaseURL)
	if origin := r.Header.Get("Origin"); origin != "" && origin != base.Scheme+"://"+base.Host && !slices.Contains(a.Config.AllowedOrigins, origin) {
		return &apiError{403, "origin_rejected", "请求来源不正确"}
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return &apiError{403, "origin_rejected", "请求来源不正确"}
	}
	return nil
}
func validPassword(password string) error {
	if !utf8.ValidString(password) || utf8.RuneCountInString(password) < 6 || len(password) > 72 {
		return bad("invalid_password", "密码至少 6 个字符，最多 72 个 UTF-8 字节")
	}
	return nil
}
func normalizeEmail(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
func (a *App) rateLimit(r *http.Request, scope, key string, max int) error {
	var count int
	err := a.DB.QueryRow(r.Context(), `INSERT INTO rate_limit_buckets(scope,key_hash,window_start,count) VALUES($1,$2,date_trunc('minute',clock_timestamp()),1) ON CONFLICT(scope,key_hash,window_start) DO UPDATE SET count=rate_limit_buckets.count+1 RETURNING count`, scope, digest([]byte(key))).Scan(&count)
	if err != nil {
		return err
	}
	if count > max {
		return &apiError{429, "rate_limited", "尝试过于频繁，请稍后重试"}
	}
	return nil
}
func clientIP(r *http.Request) string { ip, _, _ := net.SplitHostPort(r.RemoteAddr); return ip }
func (a *App) authStatus(w http.ResponseWriter, r *http.Request) error {
	var initialized, open bool
	if err := a.DB.QueryRow(r.Context(), "SELECT bootstrap_completed,registration_open FROM instance_settings WHERE id=1").Scan(&initialized, &open); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]bool{"initialized": initialized, "registration_open": open && !a.Config.RestoreMode})
	return nil
}
func (a *App) register(w http.ResponseWriter, r *http.Request) error {
	if err := a.origin(r); err != nil {
		return err
	}
	if a.Config.RestoreMode {
		return &apiError{409, "restore_mode", "恢复核对期间不能注册"}
	}
	if err := a.rateLimit(r, "register_ip", clientIP(r), 5); err != nil {
		return err
	}
	var in struct {
		Email       string          `json:"email"`
		Username    string          `json:"username"`
		DisplayName string          `json:"display_name"`
		Password    string          `json:"password"`
		UILanguage  json.RawMessage `json:"ui_language"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	language := "zh-CN"
	if len(in.UILanguage) > 0 {
		var selected *string
		if err := json.Unmarshal(in.UILanguage, &selected); err != nil || selected == nil || (*selected != "zh-CN" && *selected != "en") {
			return bad("invalid_ui_language", "界面语言仅支持简体中文和英文")
		}
		language = *selected
	}
	in.Email = normalizeEmail(in.Email)
	in.Username = normalizeEmail(in.Username)
	if !validUsername(in.Username) {
		return bad("invalid_username", "用户名须为 2–32 个字母、数字或下划线")
	}
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	if !validEmail(in.Email) {
		return bad("invalid_email", "请输入有效的邮箱地址")
	}
	if len([]rune(in.DisplayName)) < 1 || len([]rune(in.DisplayName)) > 100 {
		return bad("invalid_name", "显示名称须为 1–100 字")
	}
	if err := validPassword(in.Password); err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	u := User{ID: uuid.NewString(), Email: in.Email, Username: in.Username, DisplayName: in.DisplayName, Role: "user", Status: "active", UILanguage: language}
	sid, csrf := token(), token()
	err = persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		var initialized, open bool
		if err := tx.QueryRow(r.Context(), "SELECT bootstrap_completed,registration_open FROM instance_settings WHERE id=1 FOR UPDATE").Scan(&initialized, &open); err != nil {
			return err
		}
		if !open {
			return &apiError{403, "registration_closed", "注册已关闭，请联系管理员"}
		}
		var exists bool
		if err := tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM users WHERE email=$1)", u.Email).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return &apiError{409, "email_taken", "邮箱已被使用"}
		}
		if !initialized {
			u.Role = "admin"
		}
		if _, err := tx.Exec(r.Context(), "INSERT INTO users(id,email,display_name,password_hash,role,username,ui_language) VALUES($1,$2,$3,$4,$5,NULLIF($6,''),$7)", u.ID, u.Email, u.DisplayName, string(hash), u.Role, u.Username, u.UILanguage); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), "UPDATE instance_settings SET bootstrap_completed=true WHERE id=1"); err != nil {
			return err
		}
		return insertSession(r.Context(), tx, u.ID, sid, csrf)
	})
	if err != nil {
		return err
	}
	a.setSessionCookies(w, sid, csrf)
	a.sessionJSON(w, 201, csrf, u)
	return nil
}
func insertSession(ctx context.Context, tx pgx.Tx, userID, sid, csrf string) error {
	_, err := tx.Exec(ctx, "INSERT INTO sessions(id_hash,csrf_hash,user_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '7 days')", digest([]byte(sid)), digest([]byte(csrf)), userID)
	return err
}
func (a *App) login(w http.ResponseWriter, r *http.Request) error {
	if err := a.origin(r); err != nil {
		return err
	}
	if err := a.rateLimit(r, "login_ip", clientIP(r), 20); err != nil {
		return err
	}
	var in struct {
		Email      string `json:"email"`
		Identifier string `json:"identifier"`
		Password   string `json:"password"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	identifier := normalizeEmail(in.Identifier)
	if identifier == "" {
		identifier = normalizeEmail(in.Email)
	}
	var u User
	var hash string
	column := "username"
	if strings.Contains(identifier, "@") {
		column = "email"
	}
	err := a.DB.QueryRow(r.Context(), "SELECT id,email,COALESCE(username,''),display_name,role,status,password_hash,ui_language FROM users WHERE "+column+"=$1", identifier).Scan(&u.ID, &u.Email, &u.Username, &u.DisplayName, &u.Role, &u.Status, &hash, &u.UILanguage)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err != nil {
		hash = string(dummyPasswordHash)
	}
	limitKey := "identifier:" + identifier
	if u.ID != "" {
		limitKey = "user:" + u.ID
	}
	if err := a.rateLimit(r, "login_account", limitKey, 10); err != nil {
		return err
	}
	compare := bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password))
	if compare != nil || u.ID == "" || u.Status != "active" {
		return &apiError{401, "invalid_credentials", "用户名、邮箱或密码不正确"}
	}
	sid, csrf := token(), token()
	err = persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		// Serialize session creation with password changes and account disable.
		var currentHash, status string
		if err := tx.QueryRow(r.Context(), "SELECT password_hash,status,role,display_name,COALESCE(username,''),ui_language FROM users WHERE id=$1 FOR UPDATE", u.ID).Scan(&currentHash, &status, &u.Role, &u.DisplayName, &u.Username, &u.UILanguage); err != nil {
			return err
		}
		if status != "active" || currentHash != hash {
			return &apiError{401, "invalid_credentials", "用户名、邮箱或密码不正确"}
		}
		return insertSession(r.Context(), tx, u.ID, sid, csrf)
	})
	if err != nil {
		return err
	}
	a.setSessionCookies(w, sid, csrf)
	a.sessionJSON(w, 200, csrf, u)
	return nil
}
func (a *App) setSessionCookies(w http.ResponseWriter, sid, csrf string) {
	secure := strings.HasPrefix(a.Config.PublicBaseURL, "https://")
	for name, value := range map[string]string{"voices_session": sid, "voices_csrf": csrf} {
		http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: a.cookiePath(), HttpOnly: name == "voices_session", Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: 7 * 24 * 3600})
	}
}
func (a *App) authenticate(r *http.Request) error {
	c, err := r.Cookie("voices_session")
	if err != nil {
		return &apiError{401, "unauthenticated", "请先登录"}
	}
	var csrf string
	var u User
	err = a.DB.QueryRow(r.Context(), `SELECT s.csrf_hash,u.id,u.email,COALESCE(u.username,''),u.display_name,u.role,u.status,u.ui_language FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=$1 AND s.expires_at>clock_timestamp() AND u.status='active'`, digest([]byte(c.Value))).Scan(&csrf, &u.ID, &u.Email, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.UILanguage)
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{401, "unauthenticated", "请先登录"}
	}
	if err != nil {
		return err
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		if err := a.origin(r); err != nil {
			return err
		}
		got := digest([]byte(r.Header.Get("X-CSRF-Token")))
		if subtle.ConstantTimeCompare([]byte(csrf), []byte(got)) != 1 {
			return &apiError{403, "csrf_rejected", "会话校验失败，请刷新后重试"}
		}
	}
	*r = *r.WithContext(persistence.WithUserID(context.WithValue(r.Context(), userKey{}, u), u.ID))
	return nil
}
func (a *App) sessionJSON(w http.ResponseWriter, status int, csrf string, u User) {
	writeJSON(w, status, map[string]any{"authenticated": true, "csrf_token": csrf, "user": u, "public_base_url": a.Config.PublicBaseURL, "restore_mode": a.Config.RestoreMode})
}
func (a *App) session(w http.ResponseWriter, r *http.Request) error {
	sid, _ := r.Cookie("voices_session")
	csrf := ""
	if c, err := r.Cookie("voices_csrf"); err == nil {
		var hash string
		if err := a.DB.QueryRow(r.Context(), "SELECT csrf_hash FROM sessions WHERE id_hash=$1", digest([]byte(sid.Value))).Scan(&hash); err != nil {
			return err
		}
		if subtle.ConstantTimeCompare([]byte(hash), []byte(digest([]byte(c.Value)))) == 1 {
			csrf = c.Value
		}
	}
	if csrf == "" {
		csrf = token()
		tag, err := a.DB.Exec(r.Context(), "UPDATE sessions SET csrf_hash=$2 WHERE id_hash=$1", digest([]byte(sid.Value)), digest([]byte(csrf)))
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return &apiError{401, "unauthenticated", "请先登录"}
		}
		a.setSessionCookies(w, sid.Value, csrf)
	}
	a.sessionJSON(w, 200, csrf, currentUser(r.Context()))
	return nil
}
func (a *App) clearSessionCookies(w http.ResponseWriter) {
	for _, name := range []string{"voices_session", "voices_csrf"} {
		http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: a.cookiePath(), MaxAge: -1, Expires: time.Unix(0, 0), HttpOnly: name == "voices_session", Secure: strings.HasPrefix(a.Config.PublicBaseURL, "https://"), SameSite: http.SameSiteStrictMode})
	}
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) error {
	c, _ := r.Cookie("voices_session")
	if _, err := a.DB.Exec(r.Context(), "DELETE FROM sessions WHERE id_hash=$1", digest([]byte(c.Value))); err != nil {
		return err
	}
	a.clearSessionCookies(w)
	w.WriteHeader(204)
	return nil
}
