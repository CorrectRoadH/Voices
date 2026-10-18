-- Accounts require an explicit ownership migration when legacy business data exists.
DO $$
DECLARE t text; occupied boolean;
BEGIN
 FOREACH t IN ARRAY ARRAY['recordings','people','blobs','media_assets','transcriptions','speaker_labels','segments','jobs','provider_resources','provider_operations','blob_chunks','blob_read_leases','settings','idempotency_keys'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)',t) INTO occupied;
  IF occupied THEN RAISE EXCEPTION 'Account migration requires empty business tables; explicit ownership migration needed for %',t; END IF;
 END LOOP;
END $$;
CREATE TABLE users (
 id uuid PRIMARY KEY,
 username text NOT NULL UNIQUE CHECK(username ~ '^[a-z0-9_]{3,32}$'),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
 password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','user')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE instance_settings (
 id smallint PRIMARY KEY CHECK(id=1),bootstrap_completed boolean NOT NULL DEFAULT false,
 registration_open boolean NOT NULL DEFAULT true
);
INSERT INTO instance_settings(id) VALUES(1);
DELETE FROM sessions;
DELETE FROM rate_limit_buckets;
ALTER TABLE sessions ADD COLUMN user_id uuid NOT NULL REFERENCES users(id);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE admin_audit_events (
 id uuid PRIMARY KEY,actor_id uuid REFERENCES users(id),target_user_id uuid REFERENCES users(id),
 action text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_date ON admin_audit_events(created_at,id);
CREATE INDEX admin_audit_target ON admin_audit_events(target_user_id,created_at);
CREATE FUNCTION immutable_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN RAISE EXCEPTION 'owner is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION derive_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected uuid;
BEGIN
 EXECUTE format('SELECT owner_id FROM %I WHERE id=$1',TG_ARGV[0]) INTO expected USING (to_jsonb(NEW)->>TG_ARGV[1])::uuid;
 IF expected IS NULL OR (NEW.owner_id IS NOT NULL AND NEW.owner_id<>expected) THEN
  RAISE EXCEPTION 'invalid resource ownership' USING ERRCODE='23503';
 END IF;
 NEW.owner_id=expected;
 RETURN NEW;
END $$;
ALTER TABLE recordings ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id), ADD UNIQUE(owner_id,id);
CREATE TRIGGER recordings_owner_immutable BEFORE UPDATE ON recordings FOR EACH ROW EXECUTE FUNCTION immutable_owner();
ALTER TABLE people ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id), ADD UNIQUE(owner_id,id);
CREATE TRIGGER people_owner_immutable BEFORE UPDATE ON people FOR EACH ROW EXECUTE FUNCTION immutable_owner();
ALTER TABLE blobs ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id), ADD UNIQUE(owner_id,id);
CREATE TRIGGER blobs_owner_immutable BEFORE UPDATE ON blobs FOR EACH ROW EXECUTE FUNCTION immutable_owner();
ALTER TABLE media_assets ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id), ADD UNIQUE(owner_id,id);
CREATE TRIGGER media_assets_owner_immutable BEFORE UPDATE ON media_assets FOR EACH ROW EXECUTE FUNCTION immutable_owner();
ALTER TABLE transcriptions ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id), ADD UNIQUE(owner_id,id);
CREATE TRIGGER transcriptions_owner_immutable BEFORE UPDATE ON transcriptions FOR EACH ROW EXECUTE FUNCTION immutable_owner();
ALTER TABLE speaker_labels ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id), ADD UNIQUE(owner_id,id);
CREATE TRIGGER speaker_labels_owner_immutable BEFORE UPDATE ON speaker_labels FOR EACH ROW EXECUTE FUNCTION immutable_owner();
ALTER TABLE segments ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id), ADD UNIQUE(owner_id,id);
CREATE TRIGGER segments_owner_immutable BEFORE UPDATE ON segments FOR EACH ROW EXECUTE FUNCTION immutable_owner();
ALTER TABLE jobs ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id), ADD UNIQUE(owner_id,id);
CREATE TRIGGER jobs_owner_immutable BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION immutable_owner();
ALTER TABLE provider_resources ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id), ADD UNIQUE(owner_id,id);
CREATE TRIGGER provider_resources_owner_immutable BEFORE UPDATE ON provider_resources FOR EACH ROW EXECUTE FUNCTION immutable_owner();
ALTER TABLE provider_operations ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id), ADD UNIQUE(owner_id,id);
CREATE TRIGGER provider_operations_owner_immutable BEFORE UPDATE ON provider_operations FOR EACH ROW EXECUTE FUNCTION immutable_owner();
CREATE TRIGGER media_assets_derive_owner BEFORE INSERT ON media_assets FOR EACH ROW EXECUTE FUNCTION derive_owner('recordings','recording_id');
ALTER TABLE media_assets ADD FOREIGN KEY(owner_id,recording_id) REFERENCES recordings(owner_id,id);
CREATE TRIGGER transcriptions_derive_owner BEFORE INSERT ON transcriptions FOR EACH ROW EXECUTE FUNCTION derive_owner('recordings','recording_id');
ALTER TABLE transcriptions ADD FOREIGN KEY(owner_id,recording_id) REFERENCES recordings(owner_id,id);
CREATE TRIGGER speaker_labels_derive_owner BEFORE INSERT ON speaker_labels FOR EACH ROW EXECUTE FUNCTION derive_owner('transcriptions','transcription_id');
ALTER TABLE speaker_labels ADD FOREIGN KEY(owner_id,transcription_id) REFERENCES transcriptions(owner_id,id);
CREATE TRIGGER segments_derive_owner BEFORE INSERT ON segments FOR EACH ROW EXECUTE FUNCTION derive_owner('transcriptions','transcription_id');
ALTER TABLE segments ADD FOREIGN KEY(owner_id,transcription_id) REFERENCES transcriptions(owner_id,id);
CREATE TRIGGER jobs_derive_owner BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION derive_owner('recordings','recording_id');
ALTER TABLE jobs ADD FOREIGN KEY(owner_id,recording_id) REFERENCES recordings(owner_id,id);
CREATE TRIGGER provider_resources_derive_owner BEFORE INSERT ON provider_resources FOR EACH ROW EXECUTE FUNCTION derive_owner('transcriptions','transcription_id');
ALTER TABLE provider_resources ADD FOREIGN KEY(owner_id,transcription_id) REFERENCES transcriptions(owner_id,id);
CREATE TRIGGER provider_operations_derive_owner BEFORE INSERT ON provider_operations FOR EACH ROW EXECUTE FUNCTION derive_owner('transcriptions','transcription_id');
ALTER TABLE provider_operations ADD FOREIGN KEY(owner_id,transcription_id) REFERENCES transcriptions(owner_id,id);
ALTER TABLE media_assets ADD FOREIGN KEY(owner_id,blob_id) REFERENCES blobs(owner_id,id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE transcriptions ADD FOREIGN KEY(owner_id,raw_response_blob_id) REFERENCES blobs(owner_id,id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE speaker_labels ADD FOREIGN KEY(owner_id,person_id) REFERENCES people(owner_id,id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE segments ADD FOREIGN KEY(owner_id,source_speaker_label_id) REFERENCES speaker_labels(owner_id,id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE segments ADD FOREIGN KEY(owner_id,assigned_label_id) REFERENCES speaker_labels(owner_id,id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE jobs ADD FOREIGN KEY(owner_id,transcription_id) REFERENCES transcriptions(owner_id,id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE provider_operations ADD FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE blobs ADD FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE recordings ADD FOREIGN KEY(owner_id,active_transcription_id) REFERENCES transcriptions(owner_id,id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE recordings DROP CONSTRAINT recordings_sha256_key;
ALTER TABLE recordings ADD UNIQUE(owner_id,sha256);
CREATE INDEX recordings_owner_date ON recordings(owner_id,recorded_at DESC,id);
CREATE INDEX people_owner_name ON people(owner_id,display_name,id);
CREATE INDEX jobs_owner_date ON jobs(owner_id,created_at,id);
ALTER TABLE settings ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id);
ALTER TABLE settings DROP CONSTRAINT settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY(owner_id,key);
ALTER TABLE idempotency_keys ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id);
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE idempotency_keys ADD PRIMARY KEY(owner_id,scope,key);
