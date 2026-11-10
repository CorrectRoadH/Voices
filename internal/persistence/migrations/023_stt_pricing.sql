-- @concord-file
-- @concord-implements docs/feature/stt-pricing/README.md
-- @concord-implements docs/feature/stt-pricing/use-case/manage-estimates.md
CREATE TABLE stt_price_versions (
 id uuid PRIMARY KEY,
 provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 200),
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
 currency text NOT NULL CHECK(currency='USD'),
 hourly_rate_microusd bigint NOT NULL CHECK(hourly_rate_microusd>=0),
 diarization_hourly_rate_microusd bigint NOT NULL CHECK(diarization_hourly_rate_microusd>=0),
 basis text NOT NULL CHECK(basis='duration_estimate'),
 source text NOT NULL CHECK(length(btrim(source)) BETWEEN 1 AND 1000),
 verified_on date NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(hourly_rate_microusd::numeric+diarization_hourly_rate_microusd::numeric<=9223372036854775807)
);
CREATE INDEX stt_prices_latest ON stt_price_versions(provider,model,created_at DESC,id DESC);
CREATE FUNCTION stt_price_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'price versions are append only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER stt_price_immutable BEFORE UPDATE OR DELETE ON stt_price_versions FOR EACH ROW EXECUTE FUNCTION stt_price_immutable();

CREATE TABLE stt_calls (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES users(id),
 operation_id uuid UNIQUE,
 job_id uuid,
 transcription_id uuid,
 provider text NOT NULL,
 model text NOT NULL,
 duration_ms bigint NOT NULL CHECK(duration_ms>=0),
 diarization boolean NOT NULL,
 price_version_id uuid REFERENCES stt_price_versions(id),
 rate_microusd_per_hour bigint CHECK(rate_microusd_per_hour>=0),
 estimated_cost_microusd bigint CHECK(estimated_cost_microusd>=0),
 currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 basis text NOT NULL DEFAULT 'duration_estimate' CHECK(basis='duration_estimate'),
 origin text NOT NULL CHECK(origin IN ('submission','historical','restore_observation')),
 submission_state text NOT NULL CHECK(submission_state IN ('prepared','sent','known','uncertain','confirmed_absent')),
 result_state text NOT NULL CHECK(result_state IN ('pending','running','succeeded','failed','cancelled')),
 job_attempt integer NOT NULL DEFAULT 0 CHECK(job_attempt>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner_id,operation_id) REFERENCES provider_operations(owner_id,id) ON DELETE SET NULL (operation_id),
 FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,id) ON DELETE SET NULL (job_id),
 FOREIGN KEY(owner_id,transcription_id) REFERENCES transcriptions(owner_id,id) ON DELETE SET NULL (transcription_id),
 CHECK((price_version_id IS NULL AND rate_microusd_per_hour IS NULL AND estimated_cost_microusd IS NULL)
    OR (price_version_id IS NOT NULL AND rate_microusd_per_hour IS NOT NULL AND estimated_cost_microusd IS NOT NULL)),
 CHECK(origin='submission' OR price_version_id IS NULL)
);
CREATE INDEX stt_calls_time ON stt_calls(created_at DESC,id DESC);
CREATE INDEX stt_calls_owner_time ON stt_calls(owner_id,created_at DESC,id DESC);
CREATE INDEX stt_calls_model_time ON stt_calls(provider,model,created_at DESC,id DESC);
CREATE INDEX stt_calls_job ON stt_calls(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX stt_calls_transcription ON stt_calls(transcription_id) WHERE transcription_id IS NOT NULL;
CREATE TRIGGER stt_calls_owner_immutable BEFORE UPDATE ON stt_calls FOR EACH ROW EXECUTE FUNCTION immutable_owner();
CREATE FUNCTION stt_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.provider,NEW.model,NEW.duration_ms,NEW.diarization,NEW.price_version_id,NEW.rate_microusd_per_hour,
        NEW.estimated_cost_microusd,NEW.currency,NEW.basis,NEW.origin,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.provider,OLD.model,OLD.duration_ms,OLD.diarization,OLD.price_version_id,OLD.rate_microusd_per_hour,
        OLD.estimated_cost_microusd,OLD.currency,OLD.basis,OLD.origin,OLD.created_at) THEN
  RAISE EXCEPTION 'STT price snapshot is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stt_snapshot_immutable BEFORE UPDATE ON stt_calls FOR EACH ROW EXECUTE FUNCTION stt_snapshot_immutable();

CREATE FUNCTION stt_result(job_state text, submission text, cancelling boolean) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN submission='confirmed_absent' THEN CASE WHEN cancelling THEN 'cancelled' ELSE 'failed' END
 WHEN job_state IN ('succeeded','failed','cancelled') THEN job_state
 WHEN job_state='running' THEN 'running' ELSE 'pending' END
$$;

-- Import old intents without inventing historical prices. Migrate holds a single transaction.
INSERT INTO stt_calls(id,owner_id,operation_id,job_id,transcription_id,provider,model,duration_ms,diarization,
 origin,submission_state,result_state,job_attempt,created_at)
SELECT gen_random_uuid(),o.owner_id,o.id,j.id,t.id,t.provider,t.model,r.duration_ms,
 COALESCE((t.options_json->>'diarization')::boolean,false),'historical',o.state,
 stt_result(j.state,o.state,j.cancel_requested),j.attempt,o.created_at
FROM provider_operations o JOIN jobs j ON j.id=o.job_id JOIN transcriptions t ON t.id=o.transcription_id
JOIN recordings r ON r.id=t.recording_id WHERE o.kind='submit';

CREATE FUNCTION stt_operation_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record; p stt_price_versions%ROWTYPE; rate bigint; origin_kind text;
BEGIN
 IF NEW.kind<>'submit' THEN RETURN NEW; END IF;
 SELECT t.provider,t.model,r.duration_ms,COALESCE((t.options_json->>'diarization')::boolean,false) diarization,
 j.state job_state,j.cancel_requested,j.attempt,r.state recording_state
 INTO STRICT v FROM transcriptions t JOIN recordings r ON r.id=t.recording_id JOIN jobs j ON j.id=NEW.job_id
 WHERE t.id=NEW.transcription_id;
 IF TG_OP='INSERT' THEN
  origin_kind := CASE WHEN NEW.state='prepared' THEN 'submission' ELSE 'restore_observation' END;
  IF origin_kind='submission' THEN
   -- One SELECT owns version and both rates; only versions committed and visible here apply.
   SELECT * INTO p FROM stt_price_versions WHERE provider=v.provider AND model=v.model ORDER BY created_at DESC,id DESC LIMIT 1;
   rate := p.hourly_rate_microusd + CASE WHEN v.diarization THEN p.diarization_hourly_rate_microusd ELSE 0 END;
  END IF;
  INSERT INTO stt_calls(id,owner_id,operation_id,job_id,transcription_id,provider,model,duration_ms,diarization,
    price_version_id,rate_microusd_per_hour,estimated_cost_microusd,origin,submission_state,result_state,job_attempt,created_at)
  VALUES(gen_random_uuid(),NEW.owner_id,NEW.id,NEW.job_id,NEW.transcription_id,v.provider,v.model,v.duration_ms,v.diarization,
    p.id,rate,div(v.duration_ms::numeric*rate::numeric+3599999,3600000)::bigint,origin_kind,NEW.state,
    stt_result(v.job_state,NEW.state,v.cancel_requested),v.attempt,NEW.created_at);
 ELSE
  UPDATE stt_calls SET submission_state=NEW.state,
   result_state=CASE WHEN v.recording_state='deleting' AND result_state IN ('succeeded','failed','cancelled') THEN result_state
     ELSE stt_result(v.job_state,NEW.state,v.cancel_requested) END,
   updated_at=clock_timestamp() WHERE operation_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stt_operation_snapshot AFTER INSERT OR UPDATE OF state ON provider_operations FOR EACH ROW EXECUTE FUNCTION stt_operation_snapshot();

CREATE FUNCTION stt_job_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deleting boolean;
BEGIN
 IF NEW.kind<>'transcribe' THEN RETURN NEW; END IF;
 SELECT state='deleting' INTO deleting FROM recordings WHERE id=NEW.recording_id;
 UPDATE stt_calls SET result_state=CASE WHEN deleting AND result_state IN ('succeeded','failed','cancelled') THEN result_state
   ELSE stt_result(NEW.state,submission_state,NEW.cancel_requested) END,
   job_attempt=CASE WHEN deleting THEN job_attempt ELSE NEW.attempt END,updated_at=clock_timestamp()
 WHERE job_id=NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER stt_job_result AFTER UPDATE OF state,attempt,cancel_requested ON jobs FOR EACH ROW EXECUTE FUNCTION stt_job_result();
