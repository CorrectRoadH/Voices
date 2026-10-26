-- @concord-file
-- @concord-implements docs/feature/accounts/use-case/oidc-login.md
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE oidc_settings (
 id smallint PRIMARY KEY CHECK(id=1),
 enabled boolean NOT NULL DEFAULT false,
 display_name text NOT NULL DEFAULT '统一登录' CHECK(length(display_name) BETWEEN 1 AND 80),
 issuer_url text NOT NULL DEFAULT '',
 client_id text NOT NULL DEFAULT '',
 client_secret text NOT NULL DEFAULT '',
 revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO oidc_settings(id) VALUES(1);

CREATE TABLE user_oidc_identities (
 issuer text NOT NULL CHECK(octet_length(issuer) BETWEEN 1 AND 2048),
 subject text NOT NULL CHECK(octet_length(subject) BETWEEN 1 AND 255 AND subject !~ '[^\x01-\x7F]'),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(issuer,subject),
 UNIQUE(user_id,issuer)
);

CREATE TABLE oidc_login_flows (
 state_hash text PRIMARY KEY,
 browser_hash text NOT NULL,
 nonce_hash text NOT NULL,
 pkce_verifier text NOT NULL,
 settings_revision bigint NOT NULL,
 redirect_uri text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('login','link')),
 user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 session_hash text,
 expires_at timestamptz NOT NULL,
 CHECK((purpose='login' AND user_id IS NULL AND session_hash IS NULL)
    OR (purpose='link' AND user_id IS NOT NULL AND session_hash IS NOT NULL))
);
CREATE INDEX oidc_login_flows_expiry ON oidc_login_flows(expires_at);
