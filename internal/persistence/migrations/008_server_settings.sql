-- Instance configuration is separate from per-user preferences. Contains credentials.
CREATE TABLE server_settings (
 id smallint PRIMARY KEY CHECK (id = 1),
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 value_json jsonb NOT NULL CHECK (jsonb_typeof(value_json) = 'object'),
 updated_at timestamptz NOT NULL DEFAULT now()
);
