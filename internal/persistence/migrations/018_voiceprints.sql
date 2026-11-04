ALTER TABLE speaker_labels ADD COLUMN identity_source text NOT NULL DEFAULT 'manual'
 CHECK(identity_source IN ('unassigned','manual','automatic')),
 ADD COLUMN match_score double precision CHECK(match_score BETWEEN 0 AND 1);
-- Existing NULLs may represent explicit human unlinking. Preserve all old intent.
ALTER TABLE speaker_labels ALTER COLUMN identity_source SET DEFAULT 'unassigned';
ALTER TABLE speaker_labels ADD CHECK(identity_source<>'automatic' OR (person_id IS NOT NULL AND match_score IS NOT NULL));

CREATE TABLE speaker_voiceprints (
 label_id uuid PRIMARY KEY REFERENCES speaker_labels(id) ON DELETE CASCADE,
 model text NOT NULL, embedding double precision[] NOT NULL CHECK(array_length(embedding,1)=192),
 sample_ms bigint NOT NULL CHECK(sample_ms BETWEEN 6000 AND 30000),
 sample_count integer NOT NULL CHECK(sample_count BETWEEN 2 AND 6),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE voiceprint_tasks (
 transcription_id uuid PRIMARY KEY REFERENCES transcriptions(id) ON DELETE CASCADE,
 generation uuid NOT NULL, state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
 lease_until timestamptz, error_code text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX voiceprint_pending ON voiceprint_tasks(state,updated_at);
CREATE TABLE voiceprint_execution (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),run_id uuid,lease_until timestamptz
);
INSERT INTO voiceprint_execution(id) VALUES(true);
