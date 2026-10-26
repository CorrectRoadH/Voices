package app

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
)

// fakeOIDC models only the external provider. Production discovery, exchange,
// verification, account persistence and sessions are exercised without stubs.
type fakeOIDC struct {
	server     *httptest.Server
	mu         sync.Mutex
	key        *rsa.PrivateKey
	claims     map[string]any
	userinfo   map[string]any
	codes      map[string]url.Values
	tokenHook  func()
	tokenCalls int
}

func newFakeOIDC(t *testing.T) *fakeOIDC {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &fakeOIDC{key: key, claims: map[string]any{"sub": "external-user", "email": "external@example.test", "email_verified": true, "name": "External User"}, codes: map[string]url.Values{}}
	p.server = httptest.NewServer(http.HandlerFunc(p.handle))
	t.Cleanup(p.server.Close)
	return p
}
func (p *fakeOIDC) handle(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/.well-known/openid-configuration":
		writeJSON(w, 200, map[string]any{"issuer": p.server.URL, "authorization_endpoint": p.server.URL + "/authorize", "token_endpoint": p.server.URL + "/token", "jwks_uri": p.server.URL + "/jwks", "userinfo_endpoint": p.server.URL + "/userinfo", "id_token_signing_alg_values_supported": []string{"RS256"}, "token_endpoint_auth_methods_supported": []string{"client_secret_basic"}, "code_challenge_methods_supported": []string{"S256"}})
	case "/jwks":
		writeJSON(w, 200, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &p.key.PublicKey, KeyID: "test-key", Algorithm: "RS256", Use: "sig"}}})
	case "/authorize":
		q := r.URL.Query()
		if q.Get("response_type") != "code" || q.Get("client_id") != "voices-test" || q.Get("code_challenge_method") != "S256" || q.Get("nonce") == "" || q.Get("scope") != "openid email profile" {
			http.Error(w, "invalid authorization", 400)
			return
		}
		code := uuid.NewString()
		p.mu.Lock()
		p.codes[code] = q
		p.mu.Unlock()
		callback, err := url.Parse(q.Get("redirect_uri"))
		if err != nil {
			http.Error(w, "invalid callback", 400)
			return
		}
		values := callback.Query()
		values.Set("code", code)
		values.Set("state", q.Get("state"))
		callback.RawQuery = values.Encode()
		w.Header().Set("X-Test-Callback", callback.String())
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><html><head><title>Test Identity</title></head><body><h1>Test Identity</h1><a href="%s">Continue to Voices</a></body></html>`, html.EscapeString(callback.String()))
	case "/token":
		if err := r.ParseForm(); err != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		client, secret, _ := r.BasicAuth()
		p.mu.Lock()
		q, ok := p.codes[r.Form.Get("code")]
		delete(p.codes, r.Form.Get("code"))
		claims := map[string]any{}
		for k, v := range p.claims {
			claims[k] = v
		}
		hook := p.tokenHook
		p.tokenCalls++
		p.mu.Unlock()
		hashed := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !ok || client != "voices-test" || secret != "test-client-secret" || r.Form.Get("grant_type") != "authorization_code" || q.Get("redirect_uri") != r.Form.Get("redirect_uri") || q.Get("code_challenge") != base64.RawURLEncoding.EncodeToString(hashed[:]) {
			http.Error(w, "invalid grant", 400)
			return
		}
		if hook != nil {
			hook()
		}
		for k, v := range map[string]any{"iss": p.server.URL, "aud": "voices-test", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(), "nonce": q.Get("nonce")} {
			if _, exists := claims[k]; !exists {
				claims[k] = v
			}
		}
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: p.key}, (&jose.SignerOptions{}).WithHeader("kid", "test-key"))
		if err != nil {
			http.Error(w, "signer", 500)
			return
		}
		signed, err := signer.Sign(jsonBytes(claims))
		if err != nil {
			http.Error(w, "signing", 500)
			return
		}
		raw, err := signed.CompactSerialize()
		if err != nil {
			http.Error(w, "serialization", 500)
			return
		}
		if claims["test_bad_signature"] == true {
			parts := strings.Split(raw, ".")
			if parts[2][0] == 'A' {
				parts[2] = "B" + parts[2][1:]
			} else {
				parts[2] = "A" + parts[2][1:]
			}
			raw = strings.Join(parts, ".")
		}
		writeJSON(w, 200, map[string]any{"access_token": "test-access-token", "token_type": "Bearer", "expires_in": 3600, "id_token": raw})
	case "/userinfo":
		if r.Header.Get("Authorization") != "Bearer test-access-token" {
			http.Error(w, "invalid token", 401)
			return
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		writeJSON(w, 200, p.userinfo)
	default:
		http.NotFound(w, r)
	}
}
func (p *fakeOIDC) setClaims(claims map[string]any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.claims = claims
}
func configureOIDC(t *testing.T, f *fixture, p *fakeOIDC) {
	t.Helper()
	f.json(t, "PATCH", "/api/v1/admin/oidc", map[string]any{"revision": 1, "enabled": true, "display_name": "Test Identity", "issuer_url": p.server.URL, "client_id": "voices-test", "client_secret": "test-client-secret"}, 200, "")
}
func oidcVisitor(f *fixture) *fixture {
	jar, _ := cookiejar.New(nil)
	return &fixture{a: f.a, db: f.db, server: f.server, client: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func startOIDC(t *testing.T, f *fixture, link bool) string {
	t.Helper()
	path := "/api/v1/auth/oidc/start"
	if link {
		path = "/api/v1/me/oidc"
	}
	_, result := f.json(t, "POST", path, map[string]any{}, 200, "")
	res, err := f.client.Get(result["authorization_url"].(string))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("authorization failed: %d", res.StatusCode)
	}
	callback := res.Header.Get("X-Test-Callback")
	if callback == "" {
		t.Fatal("missing callback")
	}
	return callback
}
func finishOIDC(t *testing.T, f *fixture, callback, want string) {
	t.Helper()
	res, err := f.client.Get(callback)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 303 {
		t.Fatalf("callback status %d", res.StatusCode)
	}
	location := res.Header.Get("Location")
	if want == "" {
		if strings.Contains(location, "oidc_error") {
			t.Fatal(location)
		}
	} else if !strings.Contains(location, "oidc_error="+want) {
		t.Fatalf("callback %s want %s", location, want)
	}
}
func oidcSession(t *testing.T, f *fixture) map[string]any {
	t.Helper()
	_, session := f.json(t, "GET", "/api/v1/session", nil, 200, "")
	f.csrf = session["csrf_token"].(string)
	return session
}

// @use-case docs/feature/accounts/use-case/oidc-login.md
func TestOIDCProvisionAndPasswordRecovery(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	v := oidcVisitor(f)
	_, status := v.json(t, "GET", "/api/v1/auth/status", nil, 200, "")
	if status["oidc_enabled"] != true {
		t.Fatal(status)
	}
	finishOIDC(t, v, startOIDC(t, v, false), "")
	user := oidcSession(t, v)["user"].(map[string]any)
	if user["email"] != "external@example.test" || user["role"] != "user" || user["has_password"] != false {
		t.Fatal(user)
	}
	id := user["id"]
	v.json(t, "DELETE", "/api/v1/me/oidc", nil, 400, "")
	v.json(t, "PUT", "/api/v1/me/password", map[string]any{"current_password": "", "new_password": "new-password"}, 204, "")
	v.json(t, "GET", "/api/v1/session", nil, 401, "")
	_, login := v.json(t, "POST", "/api/v1/session", map[string]any{"email": "external@example.test", "password": "new-password"}, 200, "")
	v.csrf = login["csrf_token"].(string)
	if login["user"].(map[string]any)["has_password"] != true {
		t.Fatal(login)
	}
	v.json(t, "DELETE", "/api/v1/session", nil, 204, "")
	p.setClaims(map[string]any{"sub": "external-user"}) // stable identity survives missing/changed email
	f.json(t, "PATCH", "/api/v1/admin/registration", map[string]any{"registration_open": false}, 200, "")
	finishOIDC(t, v, startOIDC(t, v, false), "")
	if oidcSession(t, v)["user"].(map[string]any)["id"] != id {
		t.Fatal("identity changed")
	}
	v.json(t, "DELETE", "/api/v1/me/oidc", nil, 204, "")
	v.json(t, "GET", "/api/v1/session", nil, 401, "")
	p.setClaims(map[string]any{"sub": "external-user", "email": "external@example.test", "email_verified": true})
	finishOIDC(t, v, startOIDC(t, v, false), "registration_closed")
}

// @use-case docs/feature/accounts/use-case/oidc-login.md
func TestOIDCBindingAndEmailCollision(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	p.setClaims(map[string]any{"sub": "admin-external", "email": "tester@example.test", "email_verified": true})
	v := oidcVisitor(f)
	finishOIDC(t, v, startOIDC(t, v, false), "account_exists")
	f.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	finishOIDC(t, f, startOIDC(t, f, true), "")
	_, bound := f.json(t, "GET", "/api/v1/me/oidc", nil, 200, "")
	if bound["linked"] != true {
		t.Fatal(bound)
	}
	finishOIDC(t, v, startOIDC(t, v, false), "")
	session := oidcSession(t, v)
	if session["user"].(map[string]any)["role"] != "admin" {
		t.Fatal(session)
	}
	// Binding an identity already owned by the admin to another local user fails.
	other := oidcVisitor(f)
	_, registered := other.json(t, "POST", "/api/v1/users", map[string]any{"email": "other@example.test", "display_name": "Other", "password": "local-password"}, 201, "")
	other.csrf = registered["csrf_token"].(string)
	finishOIDC(t, other, startOIDC(t, other, true), "identity_taken")
}

// @use-case docs/feature/accounts/use-case/oidc-login.md#login
func TestOIDCRejectsInvalidTokens(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	for _, tc := range []struct {
		name     string
		override map[string]any
	}{
		{"signature", map[string]any{"sub": "bad", "test_bad_signature": true}},
		{"missing_subject", map[string]any{}}, {"empty_subject", map[string]any{"sub": ""}}, {"long_subject", map[string]any{"sub": strings.Repeat("a", 256)}}, {"non_ascii_subject", map[string]any{"sub": "用户"}},
		{"issuer", map[string]any{"sub": "bad", "iss": "https://attacker.invalid"}}, {"audience", map[string]any{"sub": "bad", "aud": "another-client"}},
		{"expired", map[string]any{"sub": "bad", "exp": time.Now().Add(-time.Hour).Unix()}}, {"nonce", map[string]any{"sub": "bad", "nonce": "other-nonce"}},
		{"azp", map[string]any{"sub": "bad", "azp": "other-client"}}, {"multi_audience_without_azp", map[string]any{"sub": "bad", "aud": []string{"voices-test", "other"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := map[string]any{"email": "invalid@example.test", "email_verified": true}
			for k, v := range tc.override {
				claims[k] = v
			}
			p.setClaims(claims)
			v := oidcVisitor(f)
			finishOIDC(t, v, startOIDC(t, v, false), "verification_failed")
			v.json(t, "GET", "/api/v1/session", nil, 401, "")
		})
	}
	var count int
	if err := f.db.QueryRow(context.Background(), "SELECT count(*) FROM user_oidc_identities").Scan(&count); err != nil || count != 0 {
		t.Fatal("invalid token created identity", count, err)
	}
}

// @use-case docs/feature/accounts/use-case/oidc-login.md#login
func TestOIDCFlowBindingReplayAndConfiguration(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	v := oidcVisitor(f)
	callback := startOIDC(t, v, false)
	other := oidcVisitor(f)
	finishOIDC(t, other, callback, "invalid_callback")
	finishOIDC(t, v, callback, "")
	finishOIDC(t, v, callback, "invalid_callback")
	v = oidcVisitor(f)
	callback = startOIDC(t, v, false)
	_, err := f.db.Exec(context.Background(), "UPDATE oidc_login_flows SET expires_at=clock_timestamp()-interval '1 second'")
	if err != nil {
		t.Fatal(err)
	}
	finishOIDC(t, v, callback, "invalid_callback")
	callback = startOIDC(t, v, false)
	f.json(t, "PATCH", "/api/v1/admin/oidc", map[string]any{"revision": 2, "display_name": "Updated"}, 200, "")
	finishOIDC(t, v, callback, "configuration_changed")
	// A revision change during token exchange is caught again under the final lock.
	callback = startOIDC(t, v, false)
	p.mu.Lock()
	p.tokenHook = func() { f.db.Exec(context.Background(), "UPDATE oidc_settings SET revision=revision+1") }
	p.mu.Unlock()
	finishOIDC(t, v, callback, "configuration_changed")
}

// @use-case docs/feature/accounts/use-case/oidc-login.md#provision
func TestOIDCUserInfoAndLongEmail(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	longEmail := strings.Repeat("a", 60) + "@" + strings.Repeat("b", 55) + ".example.test"
	p.setClaims(map[string]any{"sub": "userinfo-only"})
	p.mu.Lock()
	p.userinfo = map[string]any{"sub": "userinfo-only", "email": longEmail, "email_verified": true}
	p.mu.Unlock()
	v := oidcVisitor(f)
	finishOIDC(t, v, startOIDC(t, v, false), "")
	user := oidcSession(t, v)["user"].(map[string]any)
	if user["email"] != longEmail || len([]rune(user["display_name"].(string))) != 100 {
		t.Fatal(user)
	}
	p.setClaims(map[string]any{"sub": "different-user"})
	v = oidcVisitor(f)
	finishOIDC(t, v, startOIDC(t, v, false), "verification_failed")
	p.setClaims(map[string]any{"sub": "unverified", "email": "unverified@example.test", "email_verified": false})
	finishOIDC(t, v, startOIDC(t, v, false), "verified_email_required")
}

// @use-case docs/feature/accounts/use-case/oidc-login.md#configure
func TestOIDCSettingsSecurity(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	_, view := f.json(t, "GET", "/api/v1/admin/oidc", nil, 200, "")
	raw, _ := json.Marshal(view)
	if strings.Contains(string(raw), "test-client-secret") || view["client_secret_configured"] != true {
		t.Fatal("secret exposed or missing")
	}
	f.json(t, "PATCH", "/api/v1/admin/oidc", map[string]any{"revision": 1, "enabled": false}, 409, "")
	f.json(t, "PATCH", "/api/v1/admin/oidc", map[string]any{"revision": 2, "issuer_url": "https://other.example"}, 400, "")
	f.json(t, "PATCH", "/api/v1/admin/oidc", map[string]any{"revision": 2, "client_secret": ""}, 400, "")
	f.json(t, "PATCH", "/api/v1/admin/oidc", map[string]any{"revision": 2, "issuer_url": "http://insecure.example"}, 400, "")
	f.json(t, "PATCH", "/api/v1/admin/oidc", map[string]any{"revision": 2, "enabled": nil}, 400, "")
	other := oidcVisitor(f)
	other.json(t, "GET", "/api/v1/admin/oidc", nil, 401, "")
	_, registered := other.json(t, "POST", "/api/v1/users", map[string]any{"email": "ordinary@example.test", "display_name": "Other", "password": "local-password"}, 201, "")
	other.csrf = registered["csrf_token"].(string)
	other.json(t, "GET", "/api/v1/admin/oidc", nil, 403, "")
	other.json(t, "PATCH", "/api/v1/admin/oidc", map[string]any{"revision": 2, "enabled": false}, 403, "")
	f.a.Config.RestoreMode = true
	f.json(t, "PATCH", "/api/v1/admin/oidc", map[string]any{"revision": 2, "enabled": false}, 409, "")
}

// @use-case docs/feature/accounts/use-case/oidc-login.md
func TestOIDCRevocationAndRestore(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	f.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	callback := startOIDC(t, f, true)
	// A copied callback cannot finish a link after the original session is revoked.
	cookies := f.client.Jar.Cookies(mustURL(f.server.URL))
	var flowCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == oidcFlowCookie {
			flowCookie = c
		}
	}
	f.json(t, "DELETE", "/api/v1/session", nil, 204, "")
	f.client.Jar.SetCookies(mustURL(f.server.URL), []*http.Cookie{flowCookie})
	finishOIDC(t, f, callback, "session_expired")
	v := oidcVisitor(f)
	finishOIDC(t, v, startOIDC(t, v, false), "")
	user := oidcSession(t, v)["user"].(map[string]any)
	f.a.Config.RestoreMode = true
	w := oidcVisitor(f)
	finishOIDC(t, w, startOIDC(t, w, false), "") // existing identity remains usable
	w.csrf = oidcSession(t, w)["csrf_token"].(string)
	w.json(t, "POST", "/api/v1/me/oidc", map[string]any{}, 409, "")
	p.setClaims(map[string]any{"sub": "new-in-restore", "email": "new@example.test", "email_verified": true})
	x := oidcVisitor(f)
	finishOIDC(t, x, startOIDC(t, x, false), "restore_mode")
	f.a.Config.RestoreMode = false
	p.setClaims(map[string]any{"sub": "external-user"})
	if _, err := f.db.Exec(context.Background(), "UPDATE users SET status='disabled' WHERE id=$1", user["id"]); err != nil {
		t.Fatal(err)
	}
	finishOIDC(t, x, startOIDC(t, x, false), "account_disabled")
}
func mustURL(raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return u
}

// @use-case docs/feature/accounts/use-case/oidc-login.md#login
func TestOIDCRejectsTamperedFlowAndCancellation(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	v := oidcVisitor(f)
	callback := startOIDC(t, v, false)
	if _, err := f.db.Exec(context.Background(), "UPDATE oidc_login_flows SET pkce_verifier='tampered-verifier'"); err != nil {
		t.Fatal(err)
	}
	finishOIDC(t, v, callback, "verification_failed")
	callback = startOIDC(t, v, false)
	u := mustURL(callback)
	q := u.Query()
	q.Del("code")
	q.Set("error", "access_denied")
	q.Set("error_description", "sensitive-provider-detail")
	u.RawQuery = q.Encode()
	finishOIDC(t, v, u.String(), "cancelled")
	finishOIDC(t, v, callback, "invalid_callback")
	callback = startOIDC(t, v, false)
	finishOIDC(t, v, callback+"&state=duplicate", "invalid_callback")
}

// @use-case docs/feature/accounts/use-case/oidc-login.md#provision
func TestOIDCConcurrentProvisionAndMultipleInstances(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	first, second := oidcVisitor(f), oidcVisitor(f)
	callbacks := []string{startOIDC(t, first, false), startOIDC(t, second, false)}
	// The second application has its own handler/config, sharing only PostgreSQL.
	other := New(f.a.Config, f.db)
	replica := httptest.NewServer(other.Handler())
	defer replica.Close()
	var wg sync.WaitGroup
	for i, v := range []*fixture{first, second} {
		wg.Add(1)
		go func(i int, v *fixture) {
			defer wg.Done()
			callback := callbacks[i]
			if i == 1 {
				callback = strings.Replace(callback, f.server.URL, replica.URL, 1)
			}
			finishOIDC(t, v, callback, "")
		}(i, v)
	}
	wg.Wait()
	one := oidcSession(t, first)["user"].(map[string]any)["id"]
	two := oidcSession(t, second)["user"].(map[string]any)["id"]
	if one != two {
		t.Fatal("concurrent identity created multiple users")
	}
	var count int
	if err := f.db.QueryRow(context.Background(), "SELECT count(*) FROM users WHERE email='external@example.test'").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
}

// @use-case docs/feature/accounts/use-case/oidc-login.md#login
func TestOIDCSubpathCallback(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	c := f.a.Config
	c.PublicBaseURL = f.server.URL + "/voices"
	app := New(c, f.db)
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	app.Config.PublicBaseURL = server.URL + "/voices"
	v := oidcVisitor(f)
	v.a = app
	// fixture URL includes the prefix while the actual server keeps its root URL.
	v.server = &httptest.Server{URL: server.URL + "/voices"}
	callback := startOIDC(t, v, false)
	if !strings.Contains(callback, "/voices/api/v1/auth/oidc/callback") {
		t.Fatal(callback)
	}
	finishOIDC(t, v, callback, "")
	if oidcSession(t, v)["user"].(map[string]any)["email"] != "external@example.test" {
		t.Fatal("subpath login failed")
	}
}

// @use-case docs/feature/accounts/use-case/oidc-login.md#recover
func TestOIDCFirstPasswordRejectsRevokedSession(t *testing.T) {
	f := setup(t)
	p := newFakeOIDC(t)
	configureOIDC(t, f, p)
	v := oidcVisitor(f)
	finishOIDC(t, v, startOIDC(t, v, false), "")
	user := oidcSession(t, v)["user"].(map[string]any)
	ctx := context.Background()
	tx, err := f.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT id FROM users WHERE id=$1 FOR UPDATE", user["id"]); err != nil {
		t.Fatal(err)
	}
	type result struct {
		response *http.Response
		err      error
	}
	done := make(chan result, 1)
	req, err := http.NewRequest("PUT", f.server.URL+"/api/v1/me/password", strings.NewReader(`{"current_password":"","new_password":"must-not-be-set"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", v.csrf)
	go func() { res, err := v.client.Do(req); done <- result{res, err} }()
	// Observe the actual SQL lock wait, so revocation happens after authenticate
	// but before the password mutation acquires the user row.
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting bool
		err = f.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT password_hash,status FROM users%')`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("password request did not reach user lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := f.db.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", user["id"]); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	response := <-done
	if response.err != nil {
		t.Fatal(response.err)
	}
	response.response.Body.Close()
	if response.response.StatusCode != 401 {
		t.Fatalf("revoked session set first password: %d", response.response.StatusCode)
	}
	var remainsNull bool
	if err := f.db.QueryRow(ctx, "SELECT password_hash IS NULL FROM users WHERE id=$1", user["id"]).Scan(&remainsNull); err != nil || !remainsNull {
		t.Fatal("password changed", err)
	}
}
