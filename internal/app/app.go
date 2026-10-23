package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"voices/internal/providers"
	"voices/internal/storage"
	"voices/internal/updates"
)

type App struct {
	StartedAt       time.Time
	runtimeWriting  atomic.Bool
	runtimeCleaning atomic.Bool
	runtimeDropped  atomic.Uint64
	Config          Config
	DB              *pgxpool.Pool
	Blobs           *storage.Store
	Providers       map[string]providers.Adapter
	InstanceID      string
	Updates         *updates.Manager
}

func New(c Config, db *pgxpool.Pool, adapters ...providers.Adapter) *App {
	a := &App{Config: c, DB: db, Blobs: &storage.Store{Pool: db}, Providers: map[string]providers.Adapter{}, InstanceID: uuid.NewString(), StartedAt: time.Now().UTC()}
	a.Updates = updates.New(context.Background(), "dev", "", nil)
	for _, p := range adapters {
		a.Providers[p.ID()] = p
	}
	return a
}

type apiError struct {
	Status        int
	Code, Message string
}

func (e *apiError) Error() string    { return e.Code }
func bad(code, message string) error { return &apiError{400, code, message} }
func conflict() error {
	return &apiError{409, "conflict", "内容已更改或请求冲突，请刷新后重试"}
}
func notFound() error { return &apiError{404, "not_found", "内容不存在或已删除"} }
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func decode(r *http.Request, v any) error {
	d := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return bad("invalid_request", "请求格式不正确")
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return bad("invalid_request", "请求只能包含一个 JSON 对象")
	}
	return nil
}
func (a *App) handle(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := uuid.NewString()
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("Cache-Control", "no-store")
		if err := fn(w, r); err != nil {
			e := &apiError{500, "internal_error", "处理失败，请稍后重试"}
			var custom *apiError
			var pe *pgconn.PgError
			if errors.As(err, &custom) {
				e = custom
			} else if errors.Is(err, pgx.ErrNoRows) {
				e = &apiError{404, "not_found", "内容不存在或已删除"}
			} else if errors.As(err, &pe) && pe.Code == "23505" && pe.ConstraintName == "users_username_key" {
				e = &apiError{409, "username_taken", "用户名已被使用"}
			} else if errors.As(err, &pe) && (pe.Code == "23505" || pe.Code == "40001") {
				e = &apiError{409, "conflict", "内容冲突，请刷新后重试"}
			} else if errors.As(err, &pe) && (pe.Code == "22P02" || pe.Code == "23503" || pe.Code == "23514") {
				e = &apiError{400, "invalid_request", "字段格式或关联不正确"}
			}
			if e.Status == 429 {
				w.Header().Set("Retry-After", "60")
			}
			if e.Status >= 500 {
				slog.Error("request failed", "request_id", id, "method", r.Method, "route", r.Pattern, "error_type", errorType(err))
				a.recordRuntime(r.Context(), "request_failed", errorType(err), id, r.Pattern, e.Status, "")
			}
			writeJSON(w, e.Status, map[string]any{"error": map[string]any{"code": e.Code, "message": e.Message, "request_id": id}})
		}
	}
}
func errorType(err error) string {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		return "postgres:" + pe.Code
	}
	return "internal"
}
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.handle(func(w http.ResponseWriter, r *http.Request) error {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := a.DB.Ping(ctx); err != nil {
			return &apiError{503, "unavailable", "数据库不可用"}
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
		return nil
	}))
	mux.HandleFunc("POST /api/v1/session", a.handle(a.login))
	mux.HandleFunc("POST /api/v1/users", a.handle(a.register))
	mux.HandleFunc("GET /api/v1/auth/status", a.handle(a.authStatus))
	protected := func(pattern string, fn func(http.ResponseWriter, *http.Request) error) {
		mux.HandleFunc(pattern, a.handle(func(w http.ResponseWriter, r *http.Request) error {
			if err := a.authenticate(r); err != nil {
				return err
			}
			if a.Config.RestoreMode && r.Method != "GET" && r.Method != "HEAD" && pattern != "DELETE /api/v1/session" && pattern != "POST /api/v1/jobs/{id}/resolve" {
				return &apiError{409, "restore_mode", "恢复核对期间仅允许查看数据和登记远端核对结果"}
			}
			if strings.HasPrefix(r.URL.Path, "/api/v1/admin/") {
				if err := requireAdmin(r); err != nil {
					return err
				}
			} else if err := a.authorizeResource(r); err != nil {
				return err
			}
			return fn(w, r)
		}))
	}
	protected("GET /api/v1/session", a.session)
	protected("PATCH /api/v1/me", a.updateMe)
	protected("PUT /api/v1/me/password", a.changePassword)
	protected("GET /api/v1/admin/onboarding", a.adminOnboarding)
	protected("POST /api/v1/admin/onboarding", a.adminOnboarding)
	protected("POST /api/v1/admin/llm-test", a.adminLLMTest)
	protected("GET /api/v1/admin/server-settings", a.adminServerSettings)
	protected("GET /api/v1/admin/updates", a.adminUpdates)
	protected("POST /api/v1/admin/updates", a.adminUpdates)
	protected("PATCH /api/v1/admin/server-settings", a.adminServerSettings)
	protected("POST /api/v1/admin/llm-models", a.adminLLMModels)
	protected("GET /api/v1/admin/users", a.adminUsers)
	protected("GET /api/v1/admin/overview", a.adminOverview)
	protected("GET /api/v1/admin/audit-events", a.adminAuditEvents)
	protected("GET /api/v1/admin/runtime-events", a.adminRuntimeEvents)
	protected("PATCH /api/v1/admin/users/{id}", a.adminUpdateUser)
	protected("GET /api/v1/admin/registration", a.adminRegistration)
	protected("PATCH /api/v1/admin/registration", a.adminRegistration)
	protected("DELETE /api/v1/session", a.logout)
	protected("GET /api/v1/providers", a.listProviders)
	protected("GET /api/v1/settings", a.getSettings)
	protected("PATCH /api/v1/settings", a.patchSettings)
	protected("GET /api/v1/recordings", a.listRecordings)
	protected("POST /api/v1/recordings", a.uploadRecording)
	protected("GET /api/v1/recordings/{id}", a.getRecording)
	protected("PATCH /api/v1/recordings/{id}", a.patchRecording)
	protected("DELETE /api/v1/recordings/{id}", a.deleteRecording)
	protected("GET /api/v1/recordings/{id}/audio", a.audio)
	protected("GET /api/v1/people", a.listPeople)
	protected("POST /api/v1/people", a.createPerson)
	protected("GET /api/v1/people/{id}", a.getPerson)
	protected("GET /api/v1/people/{id}/avatar", a.personAvatar)
	protected("PATCH /api/v1/people/{id}", a.patchPerson)
	protected("GET /api/v1/recordings/{id}/transcriptions", a.listTranscriptions)
	protected("POST /api/v1/recordings/{id}/transcriptions", a.createTranscription)
	protected("GET /api/v1/transcriptions/{id}", a.getTranscription)
	protected("GET /api/v1/transcriptions/{id}/insights", a.getInsights)
	protected("POST /api/v1/transcriptions/{id}/insights", a.createInsights)
	protected("POST /api/v1/transcriptions/{id}/activate", a.activateTranscription)
	protected("POST /api/v1/transcriptions/{id}/cancel", a.cancelTranscription)
	protected("GET /api/v1/transcriptions/{id}/segments", a.listSegments)
	protected("GET /api/v1/segments/{id}", a.getSegment)
	protected("POST /api/v1/transcriptions/{id}/references", a.createReference)
	protected("GET /api/v1/references/{code}", a.getReference)
	protected("PATCH /api/v1/segments/{id}", a.patchSegment)
	protected("POST /api/v1/transcriptions/{id}/speaker-labels", a.createLabel)
	protected("PATCH /api/v1/speaker-labels/{id}", a.patchLabel)
	protected("GET /api/v1/transcriptions/{id}/export", a.exportTranscription)
	protected("GET /api/v1/jobs", a.listJobs)
	protected("GET /api/v1/calls", a.listCalls)
	protected("GET /api/v1/admin/calls", a.adminCalls)
	protected("POST /api/v1/jobs/{id}/retry", a.retryJob)
	protected("POST /api/v1/jobs/{id}/resolve", a.resolveJob)
	mux.HandleFunc("/", a.static)
	base, _ := url.Parse(a.Config.PublicBaseURL)
	prefix := strings.TrimRight(base.Path, "/")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'")
		if prefix != "" && r.URL.Path != "/healthz" {
			if r.URL.Path == prefix {
				http.Redirect(w, r, prefix+"/", 308)
				return
			}
			if !strings.HasPrefix(r.URL.Path, prefix+"/") {
				http.NotFound(w, r)
				return
			}
			r = r.Clone(r.Context())
			r.URL.Path = strings.TrimPrefix(r.URL.Path, prefix)
		}
		mux.ServeHTTP(w, r)
	})
}
func (a *App) static(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") || r.Method != "GET" {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(a.Config.WebDir, filepath.Clean("/"+r.URL.Path))
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		http.ServeFile(w, r, path)
		return
	}
	http.ServeFile(w, r, filepath.Join(a.Config.WebDir, "index.html"))
}
func token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func digest(b []byte) string { v := sha256.Sum256(b); return hex.EncodeToString(v[:]) }
func jsonBytes(v any) []byte { b, _ := json.Marshal(v); return b }
func validID(id string) bool { _, err := uuid.Parse(id); return err == nil }
