package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"voices/internal/persistence"
	"voices/internal/providers"
)

// ServerSettings contains secrets and must never be returned by an HTTP handler.
type ServerSettings struct {
	PublicBaseURL  string   `json:"public_base_url"`
	AllowedOrigins []string `json:"allowed_origins"`
	SonioxKey      string   `json:"soniox_api_key"`
	AssemblyAIKey  string   `json:"assemblyai_api_key"`
	LLMBaseURL     string   `json:"llm_base_url"`
	LLMModel       string   `json:"llm_model"`
	LLMKey         string   `json:"llm_api_key"`
}

type serverSettingsView struct {
	PublicBaseURL        string   `json:"public_base_url"`
	AllowedOrigins       []string `json:"allowed_origins"`
	SonioxConfigured     bool     `json:"soniox_configured"`
	AssemblyAIConfigured bool     `json:"assemblyai_configured"`
	LLMBaseURL           string   `json:"llm_base_url"`
	LLMModel             string   `json:"llm_model"`
	LLMConfigured        bool     `json:"llm_configured"`
}

func settingsFromConfig(c Config) ServerSettings {
	origins := append([]string{}, c.AllowedOrigins...)
	return ServerSettings{c.PublicBaseURL, origins, c.SonioxKey, c.AssemblyAIKey, c.LLMBaseURL, c.LLMModel, c.LLMKey}
}
func (s ServerSettings) view() serverSettingsView {
	return serverSettingsView{s.PublicBaseURL, append([]string{}, s.AllowedOrigins...), s.SonioxKey != "", s.AssemblyAIKey != "", s.LLMBaseURL, s.LLMModel, s.LLMKey != ""}
}
func (s ServerSettings) apply(c Config) Config {
	c.PublicBaseURL, c.AllowedOrigins = s.PublicBaseURL, append([]string{}, s.AllowedOrigins...)
	c.SonioxKey, c.AssemblyAIKey = s.SonioxKey, s.AssemblyAIKey
	c.LLMBaseURL, c.LLMModel, c.LLMKey = s.LLMBaseURL, s.LLMModel, s.LLMKey
	c.seedEnv = nil
	return c
}
func seedServerSettings(c Config) (ServerSettings, error) {
	s := settingsFromConfig(c)
	if c.seedEnv == nil {
		err := s.validate()
		return s, err
	}
	values := c.seedEnv
	s.PublicBaseURL = values["PUBLIC_BASE_URL"]
	if s.PublicBaseURL == "" {
		s.PublicBaseURL = "http://localhost:8080"
	}
	s.AllowedOrigins = []string{}
	for _, value := range strings.Split(values["ALLOWED_ORIGINS"], ",") {
		if value = strings.TrimSpace(value); value != "" {
			s.AllowedOrigins = append(s.AllowedOrigins, value)
		}
	}
	s.LLMBaseURL, s.LLMModel = values["LLM_BASE_URL"], values["LLM_MODEL"]
	for key, dest := range map[string]*string{"SONIOX_API_KEY": &s.SonioxKey, "ASSEMBLYAI_API_KEY": &s.AssemblyAIKey, "LLM_API_KEY": &s.LLMKey} {
		value, err := configSecret(values, key)
		if err != nil {
			return s, err
		}
		*dest = value
	}
	err := s.validate()
	return s, err
}

// LoadServerConfig serializes bootstrap and reads the database on every process start.
// Empty saved fields are intentional and never fall back to environment values.
func LoadServerConfig(ctx context.Context, db *pgxpool.Pool, c Config) (Config, error) {
	var s ServerSettings
	err := persistence.Transaction(ctx, db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(771940002)"); err != nil {
			return err
		}
		var raw []byte
		err := tx.QueryRow(ctx, "SELECT value_json FROM server_settings WHERE id=1").Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			s, err = seedServerSettings(c)
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, "INSERT INTO server_settings(id,value_json) VALUES(1,$1)", jsonBytes(s))
			return err
		}
		if err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			return errors.New("invalid saved server settings")
		}
		return s.validate()
	})
	if err != nil {
		return c, err
	}
	return s.apply(c), nil
}

// NewServer is the production initialization path; adapters receive database credentials.
func NewServer(ctx context.Context, c Config, db *pgxpool.Pool) (*App, error) {
	c, err := LoadServerConfig(ctx, db, c)
	if err != nil {
		return nil, err
	}
	return New(c, db, providers.NewSoniox(c.SonioxKey), providers.NewAssemblyAI(c.AssemblyAIKey)), nil
}

func validConfigURL(value string, originOnly bool) bool {
	if len(value) > 2048 || strings.IndexFunc(value, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return false
	}
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.ContainsAny(value, "#\\") || strings.Contains(u.Host, "*") {
		return false
	}
	if port := u.Port(); port != "" { // url.Parse already rejects nonnumeric ports.
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return false
		}
	}
	if originOnly {
		return u.Path == ""
	}
	return u.RawPath == "" && (u.Path == "" || path.Clean(u.Path) == strings.TrimSuffix(u.Path, "/") || u.Path == "/")
}
func (s *ServerSettings) validate() error {
	s.PublicBaseURL = strings.TrimRight(strings.TrimSpace(s.PublicBaseURL), "/")
	s.LLMBaseURL = strings.TrimRight(strings.TrimSpace(s.LLMBaseURL), "/")
	if !validConfigURL(s.PublicBaseURL, false) {
		return bad("invalid_public_base_url", "站点 Base URL 必须是规范的 HTTP/HTTPS 绝对地址，不能包含凭据、查询参数或片段")
	}
	if s.LLMBaseURL != "" && !validConfigURL(s.LLMBaseURL, false) {
		return bad("invalid_llm_base_url", "LLM Base URL 必须是规范的 HTTP/HTTPS 绝对地址")
	}
	if len(s.AllowedOrigins) > 32 {
		return bad("invalid_origins", "最多配置 32 个可信来源")
	}
	origins := []string{}
	seen := map[string]bool{}
	for _, origin := range s.AllowedOrigins {
		origin = strings.TrimSpace(origin)
		if !validConfigURL(origin, true) {
			return bad("invalid_origins", "可信来源必须是完整 HTTP/HTTPS origin，不能包含路径或通配符")
		}
		if !seen[origin] {
			origins = append(origins, origin)
			seen[origin] = true
		}
	}
	s.AllowedOrigins = origins
	for _, secret := range []string{s.SonioxKey, s.AssemblyAIKey, s.LLMKey} {
		if len(secret) > 8192 || !utf8.ValidString(secret) || strings.IndexFunc(secret, unicode.IsControl) >= 0 {
			return bad("invalid_api_key", "API Key 最多 8192 字节，不能包含控制字符")
		}
	}
	s.LLMModel = strings.TrimSpace(s.LLMModel)
	if len([]rune(s.LLMModel)) > 200 || strings.IndexFunc(s.LLMModel, unicode.IsControl) >= 0 {
		return bad("invalid_llm_model", "模型名称最多 200 个字符，不能包含控制字符")
	}
	return nil
}

func (a *App) adminServerSettings(w http.ResponseWriter, r *http.Request) error {
	var saved ServerSettings
	var revision int64
	if r.Method == http.MethodPatch {
		var fields map[string]json.RawMessage
		if err := decode(r, &fields); err != nil {
			return err
		}
		var expected int64
		if err := json.Unmarshal(fields["revision"], &expected); err != nil || expected < 1 {
			return bad("invalid_revision", "请提供当前配置修订号")
		}
		delete(fields, "revision")
		if len(fields) == 0 {
			return bad("invalid_request", "请选择要修改的配置")
		}
		for key, value := range fields {
			switch key {
			case "public_base_url", "allowed_origins", "soniox_api_key", "assemblyai_api_key", "llm_base_url", "llm_model", "llm_api_key":
			default:
				return bad("invalid_request", "包含未知配置字段")
			}
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return bad("invalid_request", "配置值不能为 null")
			}
		}
		err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
			if err := lockAdmin(r.Context(), tx); err != nil {
				return err
			}
			var raw []byte
			if err := tx.QueryRow(r.Context(), "SELECT revision,value_json FROM server_settings WHERE id=1 FOR UPDATE").Scan(&revision, &raw); err != nil {
				return err
			}
			if revision != expected {
				return conflict()
			}
			if err := json.Unmarshal(raw, &saved); err != nil {
				return err
			}
			patch, _ := json.Marshal(fields)
			if err := json.Unmarshal(patch, &saved); err != nil {
				return bad("invalid_request", "配置字段类型不正确")
			}
			if err := saved.validate(); err != nil {
				return err
			}
			revision++
			if _, err := tx.Exec(r.Context(), "UPDATE server_settings SET value_json=$1,revision=$2,updated_at=clock_timestamp() WHERE id=1", jsonBytes(saved), revision); err != nil {
				return err
			}
			changed := make([]string, 0, len(fields))
			for key := range fields {
				changed = append(changed, key)
			}
			sort.Strings(changed)
			return audit(r.Context(), tx, persistence.UserID(r.Context()), nil, "server_settings_updated", map[string]any{"fields": changed})
		})
		if err != nil {
			return err
		}
	} else {
		var raw []byte
		if err := a.DB.QueryRow(r.Context(), "SELECT revision,value_json FROM server_settings WHERE id=1").Scan(&revision, &raw); err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &saved); err != nil {
			return err
		}
	}
	active := settingsFromConfig(a.Config)
	writeJSON(w, 200, map[string]any{"revision": revision, "saved": saved.view(), "active": active.view(), "restart_required": !reflect.DeepEqual(saved, active)})
	return nil
}
