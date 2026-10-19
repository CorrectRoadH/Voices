CREATE TABLE transcription_insights (
 transcription_id uuid PRIMARY KEY REFERENCES transcriptions(id) ON DELETE CASCADE,
 generation uuid NOT NULL, state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
 source_hash text NOT NULL, input_json jsonb, result_json jsonb, model text NOT NULL,
 error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_until timestamptz
);
CREATE INDEX insights_pending ON transcription_insights(state,created_at) WHERE state IN ('queued','running');
