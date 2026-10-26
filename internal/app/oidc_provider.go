// @concord-file
// @concord-implements docs/feature/accounts/use-case/oidc-login.md#login
package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"slices"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Every request (including JWKS and UserInfo) uses this transport and bound.
// Administrators own the issuer trust decision; anonymous requests cannot choose it.
type oidcTransport struct{}

func (oidcTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if !validOIDCURL(r.URL.String(), false) {
		return nil, errors.New("unsafe OIDC endpoint")
	}
	res, err := http.DefaultTransport.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	res.Body = &oidcResponseBody{ReadCloser: res.Body, remaining: 1 << 20}
	return res, nil
}

type oidcResponseBody struct {
	io.ReadCloser
	remaining int64
}

func (b *oidcResponseBody) Read(p []byte) (int, error) {
	if b.remaining <= 0 {
		return 0, errors.New("OIDC response too large")
	}
	if int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	n, err := b.ReadCloser.Read(p)
	b.remaining -= int64(n)
	return n, err
}
func oidcContext(ctx context.Context) context.Context {
	return oidc.ClientContext(ctx, &http.Client{Transport: oidcTransport{}, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }})
}
func discoverOIDC(ctx context.Context, s oidcSettings, redirectURI string) (*oidc.Provider, *oauth2.Config, error) {
	if !validOIDCURL(s.IssuerURL, true) {
		return nil, nil, errors.New("invalid issuer")
	}
	provider, err := oidc.NewProvider(ctx, s.IssuerURL)
	if err != nil {
		return nil, nil, err
	}
	var metadata struct {
		JWKSURL     string   `json:"jwks_uri"`
		UserInfoURL string   `json:"userinfo_endpoint"`
		AuthMethods []string `json:"token_endpoint_auth_methods_supported"`
		PKCEMethods []string `json:"code_challenge_methods_supported"`
	}
	if err := provider.Claims(&metadata); err != nil {
		return nil, nil, err
	}
	endpoint := provider.Endpoint()
	for _, u := range []string{endpoint.AuthURL, endpoint.TokenURL, metadata.JWKSURL} {
		if !validOIDCURL(u, false) {
			return nil, nil, errors.New("invalid discovery endpoint")
		}
	}
	if metadata.UserInfoURL != "" && !validOIDCURL(metadata.UserInfoURL, false) {
		return nil, nil, errors.New("invalid userinfo endpoint")
	}
	if len(metadata.PKCEMethods) > 0 && !slices.Contains(metadata.PKCEMethods, "S256") {
		return nil, nil, errors.New("provider does not support S256")
	}
	switch {
	case len(metadata.AuthMethods) == 0 || slices.Contains(metadata.AuthMethods, "client_secret_basic"):
		endpoint.AuthStyle = oauth2.AuthStyleInHeader
	case slices.Contains(metadata.AuthMethods, "client_secret_post"):
		endpoint.AuthStyle = oauth2.AuthStyleInParams
	default:
		return nil, nil, errors.New("unsupported token authentication method")
	}
	return provider, &oauth2.Config{ClientID: s.ClientID, ClientSecret: s.ClientSecret, Endpoint: endpoint, RedirectURL: redirectURI, Scopes: []string{oidc.ScopeOpenID, "email", "profile"}}, nil
}

type oidcProfile struct {
	Email           string `json:"email"`
	EmailVerified   *bool  `json:"email_verified"`
	Name            string `json:"name"`
	AuthorizedParty string `json:"azp"`
}

func validOIDCSubject(sub string) bool {
	if len(sub) == 0 || len(sub) > 255 {
		return false
	}
	for i := range len(sub) {
		if sub[i] == 0 || sub[i] > 127 {
			return false
		}
	}
	return true
}
