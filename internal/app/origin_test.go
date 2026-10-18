package app

import (
	"net/http/httptest"
	"testing"
)

// @use-case docs/feature/accounts/use-case/register.md
func TestExplicitBrowserOrigins(t *testing.T) {
	a := &App{Config: Config{PublicBaseURL: "http://192.168.0.199:5173/voices", AllowedOrigins: []string{"http://localhost:5173", "http://127.0.0.1:5173"}}}
	for _, tc := range []struct {
		origin, site string
		allowed      bool
	}{
		{"http://192.168.0.199:5173", "same-origin", true},
		{"http://localhost:5173", "same-origin", true},
		{"http://127.0.0.1:5173", "same-origin", true},
		{"http://attacker.example", "same-origin", false},
		{"http://localhost:5174", "same-origin", false},
		{"null", "", false},
		{"http://localhost:5173", "cross-site", false},
	} {
		t.Run(tc.origin+tc.site, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://attacker.example/api/v1/users", nil)
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Sec-Fetch-Site", tc.site)
			r.Header.Set("X-Forwarded-Host", "attacker.example")
			if got := a.origin(r) == nil; got != tc.allowed {
				t.Fatalf("allowed=%v want %v", got, tc.allowed)
			}
		})
	}
}

// @use-case docs/feature/accounts/use-case/register.md
func TestAllowedOriginConfiguration(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/voices")
	t.Setenv("PUBLIC_BASE_URL", "http://localhost:5173")
	t.Setenv("ALLOWED_ORIGINS", "http://127.0.0.1:5173, https://voices.example")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	initial, err := seedServerSettings(cfg)
	if err != nil || len(initial.AllowedOrigins) != 2 {
		t.Fatal("invalid imported origins", err)
	}
	for _, origin := range []string{"*", "https://*.example", "https://host/path", "https://user@host", "https://host?query=1", "null"} {
		t.Setenv("ALLOWED_ORIGINS", origin)
		cfg, err := LoadConfig()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := seedServerSettings(cfg); err == nil {
			t.Fatalf("accepted invalid origin %q", origin)
		}
	}
}
