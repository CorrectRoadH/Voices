-- Account bootstrap and site setup have independent lifecycles.
ALTER TABLE instance_settings ADD COLUMN site_setup_completed boolean NOT NULL DEFAULT false;
UPDATE instance_settings SET site_setup_completed = bootstrap_completed;
ALTER TABLE server_settings ADD COLUMN llm_test_revision bigint;
ALTER TABLE server_settings ADD CONSTRAINT llm_test_current_revision CHECK (llm_test_revision IS NULL OR llm_test_revision = revision);
-- Contains credentials; only workers read it and all terminal paths clear it.
ALTER TABLE transcription_insights ADD COLUMN llm_config_json jsonb CHECK (llm_config_json IS NULL OR jsonb_typeof(llm_config_json) = 'object');
UPDATE transcription_insights SET state='failed',error_code='interrupted',input_json=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE state IN ('queued','running');
