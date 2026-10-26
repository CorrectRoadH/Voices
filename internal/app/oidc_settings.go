// @concord-file
// @concord-implements docs/feature/accounts/use-case/oidc-login.md#configure
package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
)

// oidcSettings is server-only. HTTP responses must use view to redact the secret.
type oidcSettings struct {
	Enabled      bool   `json:"enabled"`
	DisplayName  string `json:"display_name"`
	IssuerURL    string `json:"issuer_url"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	Revision     int64  `json:"revision"`
}

type oidcQuery interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readOIDCSettings(ctx context.Context, db oidcQuery, lock bool) (oidcSettings, error) {
	var s oidcSettings
	sql := "SELECT enabled,display_name,issuer_url,client_id,client_secret,revision FROM oidc_settings WHERE id=1"
	if lock {
		sql += " FOR UPDATE"
	}
	err := db.QueryRow(ctx, sql).Scan(&s.Enabled, &s.DisplayName, &s.IssuerURL, &s.ClientID, &s.ClientSecret, &s.Revision)
	return s, err
}
func (s oidcSettings) view(redirectURI string) map[string]any {
	return map[string]any{"enabled": s.Enabled, "display_name": s.DisplayName, "issuer_url": s.IssuerURL, "client_id": s.ClientID, "client_secret_configured": s.ClientSecret != "", "revision": s.Revision, "redirect_uri": redirectURI}
}

// HTTP is only permitted on loopback for local development, including IdP endpoints.
func validOIDCURL(value string, issuer bool) bool {
	if len(value) > 2048 || strings.IndexFunc(value, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return false
	}
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" || strings.ContainsAny(value, "#\\") {
		return false
	}
	if issuer && (u.RawQuery != "" || u.ForceQuery) {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	ip := net.ParseIP(u.Hostname())
	return u.Scheme == "http" && (u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback()))
}
func (s *oidcSettings) validate() error {
	s.DisplayName = strings.TrimSpace(s.DisplayName)
	s.IssuerURL = strings.TrimSpace(s.IssuerURL)
	s.ClientID = strings.TrimSpace(s.ClientID)
	if !utf8.ValidString(s.DisplayName) || len([]rune(s.DisplayName)) < 1 || len([]rune(s.DisplayName)) > 80 || strings.IndexFunc(s.DisplayName, unicode.IsControl) >= 0 {
		return bad("invalid_oidc_name", "统一登录名称须为 1–80 个字符")
	}
	if s.IssuerURL != "" && !validOIDCURL(s.IssuerURL, true) {
		return bad("invalid_oidc_issuer", "Issuer URL 必须为 HTTPS 地址；本地开发可使用回环 HTTP 地址")
	}
	if len(s.ClientID) > 512 || !utf8.ValidString(s.ClientID) || strings.IndexFunc(s.ClientID, unicode.IsControl) >= 0 {
		return bad("invalid_oidc_client", "Client ID 格式不正确")
	}
	if len(s.ClientSecret) > 8192 || !utf8.ValidString(s.ClientSecret) || strings.IndexFunc(s.ClientSecret, unicode.IsControl) >= 0 {
		return bad("invalid_oidc_secret", "Client Secret 最多 8192 字节，不能包含控制字符")
	}
	if s.Enabled && (s.IssuerURL == "" || s.ClientID == "" || s.ClientSecret == "") {
		return bad("oidc_incomplete", "启用统一登录前，请填写 Issuer URL、Client ID 和 Client Secret")
	}
	return nil
}
func (a *App) oidcRedirectURI() string {
	return strings.TrimRight(a.Config.PublicBaseURL, "/") + "/api/v1/auth/oidc/callback"
}
func (a *App) adminOIDCSettings(w http.ResponseWriter, r *http.Request) error {
	var s oidcSettings
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
		for k, v := range fields {
			switch k {
			case "enabled", "display_name", "issuer_url", "client_id", "client_secret":
			default:
				return bad("invalid_request", "包含未知配置字段")
			}
			if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
				return bad("invalid_request", "配置值不能为 null")
			}
		}
		err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
			if err := lockAdmin(r.Context(), tx); err != nil {
				return err
			}
			var err error
			s, err = readOIDCSettings(r.Context(), tx, true)
			if err != nil {
				return err
			}
			if s.Revision != expected {
				return conflict()
			}
			oldIssuer, oldClient, oldSecret := s.IssuerURL, s.ClientID, s.ClientSecret
			raw, _ := json.Marshal(fields)
			if err := json.Unmarshal(raw, &s); err != nil {
				return bad("invalid_request", "配置字段类型不正确")
			}
			if err := s.validate(); err != nil {
				return err
			}
			if _, explicit := fields["client_secret"]; oldSecret != "" && (oldIssuer != s.IssuerURL || oldClient != s.ClientID) && !explicit {
				return bad("saved_key_target_changed", "身份平台或 Client ID 已更改，请输入新密钥或明确清除原密钥")
			}
			if s.Enabled && !validOIDCURL(a.oidcRedirectURI(), false) {
				return bad("invalid_oidc_callback", "统一登录需要 HTTPS 站点地址；本地开发可使用回环 HTTP 地址")
			}
			s.Revision++
			if _, err := tx.Exec(r.Context(), `UPDATE oidc_settings SET enabled=$1,display_name=$2,issuer_url=$3,client_id=$4,client_secret=$5,revision=$6,updated_at=clock_timestamp() WHERE id=1`, s.Enabled, s.DisplayName, s.IssuerURL, s.ClientID, s.ClientSecret, s.Revision); err != nil {
				return err
			}
			keys := make([]string, 0, len(fields))
			for k := range fields {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			return audit(r.Context(), tx, persistence.UserID(r.Context()), nil, "oidc_settings_updated", map[string]any{"fields": keys})
		})
		if err != nil {
			return err
		}
	} else {
		var err error
		s, err = readOIDCSettings(r.Context(), a.DB, false)
		if err != nil {
			return err
		}
	}
	writeJSON(w, 200, s.view(a.oidcRedirectURI()))
	return nil
}
