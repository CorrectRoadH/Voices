CREATE TABLE external_calls (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES users(id),
 category text NOT NULL CHECK(category IN ('stt','ai')),
 operation text NOT NULL CHECK(operation IN ('upload','submit','poll','fetch_result','delete_file','delete_transcription','generate_insights','list_models','test_model')),
 provider text NOT NULL CHECK(provider IN ('soniox','assemblyai','openai_compatible')),
 model text CHECK(length(model)<=200),
 recording_id uuid, transcription_id uuid, job_id uuid, operation_id uuid, generation uuid,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), deadline_at timestamptz NOT NULL,
 finished_at timestamptz, duration_ms bigint CHECK(duration_ms>=0),
 state text NOT NULL CHECK(state IN ('running','succeeded','failed','uncertain','interrupted')),
 request_started boolean, http_status smallint CHECK(http_status BETWEEN 100 AND 599),
 audio_duration_ms bigint CHECK(audio_duration_ms>=0),
 input_tokens bigint CHECK(input_tokens>=0), output_tokens bigint CHECK(output_tokens>=0), total_tokens bigint CHECK(total_tokens>=0),
 error_code text CHECK(length(error_code)<=64), error_reason text CHECK(length(error_reason)<=64)
);
CREATE TRIGGER external_calls_owner_immutable BEFORE UPDATE ON external_calls FOR EACH ROW EXECUTE FUNCTION immutable_owner();
CREATE INDEX external_calls_time ON external_calls(started_at DESC,id DESC);
CREATE INDEX external_calls_owner_time ON external_calls(owner_id,started_at DESC,id DESC);
CREATE INDEX external_calls_job_time ON external_calls(job_id,started_at DESC,id DESC) WHERE job_id IS NOT NULL;
CREATE INDEX external_calls_transcription_time ON external_calls(transcription_id,started_at DESC,id DESC) WHERE transcription_id IS NOT NULL;
CREATE INDEX external_calls_deadline ON external_calls(deadline_at) WHERE state='running';
CREATE UNIQUE INDEX external_calls_operation ON external_calls(operation_id) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX external_calls_generation ON external_calls(generation) WHERE generation IS NOT NULL;
