// @concord-file
// @concord-implements docs/feature/accounts/use-case/oidc-login.md
package app

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"
	"voices/internal/persistence"
)

const oidcFlowCookie = "voices_oidc_flow"

type oidcFlow struct {
	NonceHash   string
	Verifier    string
	Revision    int64
	RedirectURI string
	Purpose     string
	UserID      *string
	SessionHash *string
}

func (a *App) setOIDCFlowCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: oidcFlowCookie, Value: value, Path: a.cookiePath(), HttpOnly: true, Secure: strings.HasPrefix(a.Config.PublicBaseURL, "https://"), SameSite: http.SameSiteLaxMode, MaxAge: maxAge})
}
func (a *App) oidcStart(w http.ResponseWriter, r *http.Request) error {
	if err := a.origin(r); err != nil {
		return err
	}
	// A JSON-only start cannot be submitted by a cross-site HTML form.
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return bad("invalid_request", "请求格式不正确")
	}
	var in struct{}
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := a.rateLimit(r, "oidc_start", clientIP(r), 20); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	ctx = oidcContext(ctx)
	s, err := readOIDCSettings(ctx, a.DB, false)
	if err != nil {
		return err
	}
	var ready bool
	if err := a.DB.QueryRow(ctx, "SELECT bootstrap_completed AND site_setup_completed FROM instance_settings WHERE id=1").Scan(&ready); err != nil {
		return err
	}
	if !s.Enabled || !ready {
		return &apiError{409, "oidc_disabled", "统一登录尚未启用"}
	}
	redirectURI := a.oidcRedirectURI()
	if !validOIDCURL(redirectURI, false) {
		return bad("invalid_oidc_callback", "统一登录需要 HTTPS 站点地址；本地开发可使用回环 HTTP 地址")
	}
	_, config, err := discoverOIDC(ctx, s, redirectURI)
	if err != nil {
		return &apiError{502, "oidc_unavailable", "无法连接身份平台，请稍后重试或使用密码登录"}
	}
	state, browser, nonce, verifier := token(), token(), token(), oauth2.GenerateVerifier()
	purpose := "login"
	var userID, sessionHash *string
	opts := []oauth2.AuthCodeOption{oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)}
	if u := currentUser(r.Context()); u.ID != "" {
		purpose = "link"
		userID = &u.ID
		cookie, err := r.Cookie("voices_session")
		if err != nil {
			return &apiError{401, "unauthenticated", "请先登录"}
		}
		hash := digest([]byte(cookie.Value))
		sessionHash = &hash
		opts = append(opts, oauth2.SetAuthURLParam("prompt", "login"))
	}
	if _, err := a.DB.Exec(ctx, "DELETE FROM oidc_login_flows WHERE expires_at<clock_timestamp()"); err != nil {
		return err
	}
	if _, err := a.DB.Exec(ctx, `INSERT INTO oidc_login_flows(state_hash,browser_hash,nonce_hash,pkce_verifier,settings_revision,redirect_uri,purpose,user_id,session_hash,expires_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '10 minutes')`, digest([]byte(state)), digest([]byte(browser)), digest([]byte(nonce)), verifier, s.Revision, redirectURI, purpose, userID, sessionHash); err != nil {
		return err
	}
	a.setOIDCFlowCookie(w, browser, 600)
	writeJSON(w, 200, map[string]string{"authorization_url": config.AuthCodeURL(state, opts...)})
	return nil
}

// Callbacks only expose fixed local errors, never provider payloads or tokens.
func (a *App) oidcCallback(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Referrer-Policy", "no-referrer")
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	ctx = oidcContext(ctx)
	flow, code := a.consumeOIDCFlow(ctx, r)
	a.setOIDCFlowCookie(w, "", -1)
	target := a.cookiePath()
	if flow.Purpose == "link" {
		target += "account"
	}
	failure := func(reason string) error {
		http.Redirect(w, r, target+"?oidc_error="+url.QueryEscape(reason), http.StatusSeeOther)
		return nil
	}
	if code != "" {
		return failure(code)
	}
	q := r.URL.Query()
	if q.Get("error") != "" {
		return failure("cancelled")
	}
	if len(q["code"]) != 1 || q.Get("code") == "" || len(q.Get("code")) > 8192 {
		return failure("invalid_callback")
	}
	s, err := readOIDCSettings(ctx, a.DB, false)
	if err != nil {
		return failure("unavailable")
	}
	if !s.Enabled || s.Revision != flow.Revision || flow.RedirectURI != a.oidcRedirectURI() {
		return failure("configuration_changed")
	}
	if responseIssuer := q.Get("iss"); responseIssuer != "" && responseIssuer != s.IssuerURL {
		return failure("invalid_callback")
	}
	provider, config, err := discoverOIDC(ctx, s, flow.RedirectURI)
	if err != nil {
		return failure("unavailable")
	}
	tokens, err := config.Exchange(ctx, q.Get("code"), oauth2.VerifierOption(flow.Verifier))
	if err != nil {
		return failure("verification_failed")
	}
	raw, ok := tokens.Extra("id_token").(string)
	if !ok {
		return failure("verification_failed")
	}
	id, err := provider.VerifierContext(ctx, &oidc.Config{ClientID: s.ClientID}).Verify(ctx, raw)
	if err != nil || !validOIDCSubject(id.Subject) {
		return failure("verification_failed")
	}
	if subtle.ConstantTimeCompare([]byte(digest([]byte(id.Nonce))), []byte(flow.NonceHash)) != 1 || id.IssuedAt.After(time.Now().Add(time.Minute)) {
		return failure("verification_failed")
	}
	var profile oidcProfile
	if err := id.Claims(&profile); err != nil {
		return failure("verification_failed")
	}
	if (len(id.Audience) > 1 && profile.AuthorizedParty == "") || (profile.AuthorizedParty != "" && profile.AuthorizedParty != s.ClientID) {
		return failure("verification_failed")
	}
	// Only provisioning needs profile claims. Existing identities and explicit linking
	// work even when the provider does not disclose an email address.
	var known bool
	if err := a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM user_oidc_identities WHERE issuer=$1 AND subject=$2)", s.IssuerURL, id.Subject).Scan(&known); err != nil {
		return failure("unavailable")
	}
	if flow.Purpose == "login" && !known && (profile.Email == "" || profile.EmailVerified == nil) && provider.UserInfoEndpoint() != "" {
		info, err := provider.UserInfo(ctx, oauth2.StaticTokenSource(tokens))
		if err != nil || info.Subject != id.Subject {
			return failure("verification_failed")
		}
		// Do not mix email and verification claims from different documents.
		profile = oidcProfile{}
		if err := info.Claims(&profile); err != nil {
			return failure("verification_failed")
		}
	}
	sid, csrf := token(), token()
	reason, err := a.finishOIDC(ctx, s, flow, id.Subject, profile, sid, csrf)
	if err != nil {
		return failure("unavailable")
	}
	if reason != "" {
		return failure(reason)
	}
	if flow.Purpose == "login" {
		a.setSessionCookies(w, sid, csrf)
	} else {
		target += "?oidc_linked=1"
	}
	http.Redirect(w, r, target, http.StatusSeeOther)
	return nil
}
func (a *App) consumeOIDCFlow(ctx context.Context, r *http.Request) (oidcFlow, string) {
	var flow oidcFlow
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return flow, "invalid_callback"
	}
	for _, key := range []string{"state", "code", "error", "iss"} {
		if len(q[key]) > 1 {
			return flow, "invalid_callback"
		}
	}
	state := q.Get("state")
	cookie, err := r.Cookie(oidcFlowCookie)
	if err != nil || len(state) != 64 || len(cookie.Value) != 64 {
		return flow, "invalid_callback"
	}
	err = a.DB.QueryRow(ctx, `DELETE FROM oidc_login_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>clock_timestamp()
 RETURNING nonce_hash,pkce_verifier,settings_revision,redirect_uri,purpose,user_id,session_hash`, digest([]byte(state)), digest([]byte(cookie.Value))).Scan(&flow.NonceHash, &flow.Verifier, &flow.Revision, &flow.RedirectURI, &flow.Purpose, &flow.UserID, &flow.SessionHash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return flow, "invalid_callback"
		}
		return flow, "unavailable"
	}
	return flow, ""
}

func (a *App) finishOIDC(ctx context.Context, s oidcSettings, flow oidcFlow, subject string, profile oidcProfile, sid, csrf string) (string, error) {
	reason := ""
	err := persistence.Transaction(ctx, a.DB, func(tx pgx.Tx) error {
		var initialized, open, completed bool
		// This shared row serializes provisioning/binding/unbinding with admin changes.
		if err := tx.QueryRow(ctx, "SELECT bootstrap_completed,registration_open,site_setup_completed FROM instance_settings WHERE id=1 FOR UPDATE").Scan(&initialized, &open, &completed); err != nil {
			return err
		}
		current, err := readOIDCSettings(ctx, tx, true)
		if err != nil {
			return err
		}
		if !current.Enabled || current.Revision != flow.Revision {
			reason = "configuration_changed"
			return nil
		}
		if !initialized || !completed {
			reason = "configuration_changed"
			return nil
		}
		var userID string
		err = tx.QueryRow(ctx, "SELECT user_id FROM user_oidc_identities WHERE issuer=$1 AND subject=$2", s.IssuerURL, subject).Scan(&userID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if flow.Purpose == "link" {
			if a.Config.RestoreMode {
				reason = "restore_mode"
				return nil
			}
			if flow.UserID == nil || flow.SessionHash == nil {
				reason = "invalid_callback"
				return nil
			}
			if userID != "" && userID != *flow.UserID {
				reason = "identity_taken"
				return nil
			}
			userID = *flow.UserID
			var status string
			if err := tx.QueryRow(ctx, "SELECT status FROM users WHERE id=$1 FOR UPDATE", userID).Scan(&status); err != nil {
				return err
			}
			if status != "active" {
				reason = "account_disabled"
				return nil
			}
			var active bool
			err = tx.QueryRow(ctx, "SELECT true FROM sessions WHERE id_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR UPDATE", *flow.SessionHash, userID).Scan(&active)
			if errors.Is(err, pgx.ErrNoRows) {
				reason = "session_expired"
				return nil
			}
			if err != nil {
				return err
			}
			var bound string
			err = tx.QueryRow(ctx, "SELECT subject FROM user_oidc_identities WHERE user_id=$1 AND issuer=$2", userID, s.IssuerURL).Scan(&bound)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if bound != "" {
				if bound != subject {
					reason = "identity_taken"
				}
				return nil
			}
			if _, err := tx.Exec(ctx, "INSERT INTO user_oidc_identities(issuer,subject,user_id) VALUES($1,$2,$3)", s.IssuerURL, subject, userID); err != nil {
				return err
			}
			return audit(ctx, tx, userID, userID, "oidc_identity_linked", map[string]any{})
		}
		if userID == "" {
			if a.Config.RestoreMode {
				reason = "restore_mode"
				return nil
			}
			if !open {
				reason = "registration_closed"
				return nil
			}
			email := normalizeEmail(profile.Email)
			if profile.EmailVerified == nil || !*profile.EmailVerified || !validEmail(email) {
				reason = "verified_email_required"
				return nil
			}
			var exists bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE email=$1)", email).Scan(&exists); err != nil {
				return err
			}
			if exists {
				reason = "account_exists"
				return nil
			}
			name := strings.TrimSpace(profile.Name)
			if !utf8.ValidString(name) || len([]rune(name)) < 1 || len([]rune(name)) > 100 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
				runes := []rune(email)
				if len(runes) > 100 {
					runes = runes[:100]
				}
				name = string(runes)
			}
			userID = uuid.NewString()
			if _, err := tx.Exec(ctx, "INSERT INTO users(id,email,display_name,password_hash,role,ui_language) VALUES($1,$2,$3,NULL,'user','zh-CN')", userID, email, name); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "INSERT INTO user_oidc_identities(issuer,subject,user_id) VALUES($1,$2,$3)", s.IssuerURL, subject, userID); err != nil {
				return err
			}
		}
		var status string
		if err := tx.QueryRow(ctx, "SELECT status FROM users WHERE id=$1 FOR UPDATE", userID).Scan(&status); err != nil {
			return err
		}
		if status != "active" {
			reason = "account_disabled"
			return nil
		}
		// All identity mutations take instance_settings first. The binding above is
		// therefore stable while holding the user lock and creating the session.
		return insertSession(ctx, tx, userID, sid, csrf)
	})
	return reason, err
}

func (a *App) myOIDC(w http.ResponseWriter, r *http.Request) error {
	if r.Method == http.MethodPost {
		return a.oidcStart(w, r)
	}
	if r.Method == http.MethodDelete {
		err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
			if _, err := tx.Exec(r.Context(), "SELECT id FROM instance_settings WHERE id=1 FOR UPDATE"); err != nil {
				return err
			}
			s, err := readOIDCSettings(r.Context(), tx, true)
			if err != nil {
				return err
			}
			var hasPassword bool
			u := currentUser(r.Context())
			if err := tx.QueryRow(r.Context(), "SELECT password_hash IS NOT NULL FROM users WHERE id=$1 AND status='active' FOR UPDATE", u.ID).Scan(&hasPassword); err != nil {
				return err
			}
			if !hasPassword {
				return bad("password_required", "请先设置本地密码，再解绑统一登录")
			}
			if _, err := tx.Exec(r.Context(), "DELETE FROM user_oidc_identities WHERE issuer=$1 AND user_id=$2", s.IssuerURL, u.ID); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), "DELETE FROM sessions WHERE user_id=$1", u.ID); err != nil {
				return err
			}
			return audit(r.Context(), tx, u.ID, u.ID, "oidc_identity_unlinked", map[string]any{})
		})
		if err != nil {
			return err
		}
		a.clearSessionCookies(w)
		a.setOIDCFlowCookie(w, "", -1)
		w.WriteHeader(204)
		return nil
	}
	s, err := readOIDCSettings(r.Context(), a.DB, false)
	if err != nil {
		return err
	}
	var linked bool
	if err := a.DB.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM user_oidc_identities WHERE user_id=$1 AND issuer=$2)", persistence.UserID(r.Context()), s.IssuerURL).Scan(&linked); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"enabled": s.Enabled, "display_name": s.DisplayName, "linked": linked, "has_password": currentUser(r.Context()).HasPassword})
	return nil
}
