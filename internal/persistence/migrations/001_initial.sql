CREATE TABLE people (
 id uuid PRIMARY KEY, display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200), notes text NOT NULL DEFAULT '',
 archived_at timestamptz, revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recordings (
 id uuid PRIMARY KEY, sha256 text NOT NULL UNIQUE, title text NOT NULL, original_name text NOT NULL,
 recorded_at timestamptz NOT NULL, recorded_at_source text NOT NULL CHECK(recorded_at_source IN ('user','import')),
 notes text NOT NULL DEFAULT '', duration_ms bigint NOT NULL CHECK(duration_ms>=0), size_bytes bigint NOT NULL CHECK(size_bytes>0), mime_type text NOT NULL,
 state text NOT NULL CHECK(state IN ('preparing','ready','failed','deleting')), active_transcription_id uuid, deleted_at timestamptz,
 revision bigint NOT NULL DEFAULT 1, auto_transcribe boolean NOT NULL, import_transcription_options jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((auto_transcribe AND import_transcription_options IS NOT NULL) OR (NOT auto_transcribe AND import_transcription_options IS NULL))
);
CREATE INDEX recordings_date ON recordings(recorded_at DESC,id);
CREATE INDEX recordings_state ON recordings(state,created_at);
CREATE TABLE blobs (
 id uuid PRIMARY KEY, state text NOT NULL CHECK(state IN ('writing','ready','deleting')),
 chunk_size integer NOT NULL DEFAULT 1048576 CHECK(chunk_size=1048576),chunk_count integer NOT NULL DEFAULT 0 CHECK(chunk_count>=0),size_bytes bigint NOT NULL DEFAULT 0 CHECK(size_bytes>=0),sha256 text,
 writer_id uuid,write_generation bigint NOT NULL DEFAULT 1,write_lease_until timestamptz,job_id uuid,job_generation bigint,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blobs_gc ON blobs(state,write_lease_until);
CREATE TABLE blob_chunks (
 blob_id uuid NOT NULL REFERENCES blobs(id),ordinal integer NOT NULL CHECK(ordinal>=0),data bytea NOT NULL CHECK(octet_length(data) BETWEEN 1 AND 1048576),PRIMARY KEY(blob_id,ordinal)
);
CREATE TABLE blob_read_leases (
 id uuid PRIMARY KEY,blob_id uuid NOT NULL REFERENCES blobs(id),holder_id uuid NOT NULL,expires_at timestamptz NOT NULL
);
CREATE INDEX blob_leases_expiration ON blob_read_leases(blob_id,expires_at);
CREATE TABLE media_assets (
 id uuid PRIMARY KEY,recording_id uuid NOT NULL REFERENCES recordings(id),kind text NOT NULL CHECK(kind IN ('original','playback','stt')),
 blob_id uuid NOT NULL UNIQUE REFERENCES blobs(id),error_code text,UNIQUE(recording_id,kind)
);
CREATE TABLE transcriptions (
 id uuid PRIMARY KEY,recording_id uuid NOT NULL REFERENCES recordings(id),provider text NOT NULL,model text NOT NULL,
 options_json jsonb NOT NULL,capability_snapshot_json jsonb NOT NULL,state text NOT NULL,error_code text,revision bigint NOT NULL DEFAULT 1,
 raw_response_blob_id uuid UNIQUE REFERENCES blobs(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(recording_id,id)
);
ALTER TABLE recordings ADD CONSTRAINT active_version FOREIGN KEY(id,active_transcription_id) REFERENCES transcriptions(recording_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX transcription_recording ON transcriptions(recording_id,created_at);
CREATE TABLE speaker_labels (
 id uuid PRIMARY KEY,transcription_id uuid NOT NULL REFERENCES transcriptions(id),provider_label text,display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),person_id uuid REFERENCES people(id),revision bigint NOT NULL DEFAULT 1,
 UNIQUE(transcription_id,provider_label),UNIQUE(transcription_id,id)
);
CREATE INDEX speaker_person ON speaker_labels(person_id);
CREATE TABLE segments (
 id uuid PRIMARY KEY,transcription_id uuid NOT NULL REFERENCES transcriptions(id),ordinal integer NOT NULL CHECK(ordinal>=0),start_ms bigint,end_ms bigint,
 source_text text NOT NULL,edited_text text,source_speaker_label_id uuid,assignment_mode text NOT NULL DEFAULT 'inherit' CHECK(assignment_mode IN ('inherit','label','unknown')),
 assigned_label_id uuid,revision bigint NOT NULL DEFAULT 1,UNIQUE(transcription_id,ordinal),
 FOREIGN KEY(transcription_id,source_speaker_label_id) REFERENCES speaker_labels(transcription_id,id),
 FOREIGN KEY(transcription_id,assigned_label_id) REFERENCES speaker_labels(transcription_id,id),
 CHECK((start_ms IS NULL AND end_ms IS NULL) OR (start_ms IS NOT NULL AND end_ms IS NOT NULL AND start_ms>=0 AND end_ms>=start_ms)),
 CHECK((assignment_mode='label' AND assigned_label_id IS NOT NULL) OR (assignment_mode<>'label' AND assigned_label_id IS NULL))
);
CREATE INDEX segments_time ON segments(transcription_id,start_ms);
CREATE TABLE jobs (
 id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('prepare','transcribe')),recording_id uuid NOT NULL REFERENCES recordings(id),transcription_id uuid REFERENCES transcriptions(id),
 dedupe_key text NOT NULL UNIQUE,stage text NOT NULL,state text NOT NULL CHECK(state IN ('queued','running','retry_wait','uncertain','restore_hold','succeeded','failed','cancelled')),
 attempt integer NOT NULL DEFAULT 0,next_run_at timestamptz NOT NULL DEFAULT now(),lease_owner uuid,lease_until timestamptz,lease_generation bigint NOT NULL DEFAULT 0,error_code text,cancel_requested boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_schedule ON jobs(state,next_run_at);
ALTER TABLE blobs ADD CONSTRAINT blob_job FOREIGN KEY(job_id) REFERENCES jobs(id);
CREATE TABLE provider_resources (
 id uuid PRIMARY KEY,transcription_id uuid NOT NULL REFERENCES transcriptions(id),provider text NOT NULL,kind text NOT NULL CHECK(kind IN ('file','transcription')),remote_id text NOT NULL,
 cleanup_state text NOT NULL DEFAULT 'pending' CHECK(cleanup_state IN ('pending','deleting','deleted','failed')),next_cleanup_at timestamptz,last_error text,
 UNIQUE(provider,kind,remote_id)
);
CREATE INDEX resource_cleanup ON provider_resources(cleanup_state,next_cleanup_at);
CREATE TABLE provider_operations (
 id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES jobs(id),transcription_id uuid NOT NULL REFERENCES transcriptions(id),kind text NOT NULL CHECK(kind IN ('upload','submit')),lease_generation bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','sent','known','uncertain','confirmed_absent')),remote_id text,resolution_note text,terminal_evidence jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operations_job ON provider_operations(job_id,kind,created_at);
CREATE TABLE idempotency_keys(scope text NOT NULL,key text NOT NULL,request_hash text NOT NULL,resource_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(scope,key));
CREATE TABLE settings(key text PRIMARY KEY,value_json jsonb NOT NULL);
CREATE TABLE sessions(id_hash text PRIMARY KEY,csrf_hash text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX sessions_expiration ON sessions(expires_at);
CREATE TABLE rate_limit_buckets(scope text NOT NULL,key_hash text NOT NULL,window_start timestamptz NOT NULL,count integer NOT NULL,PRIMARY KEY(scope,key_hash,window_start));
