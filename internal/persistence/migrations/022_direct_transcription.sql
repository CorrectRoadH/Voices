ALTER TABLE jobs ADD COLUMN direct_request_started_at timestamptz;

ALTER TABLE external_calls DROP CONSTRAINT external_calls_operation_check;
ALTER TABLE external_calls ADD CONSTRAINT external_calls_operation_check
 CHECK(operation IN ('upload','submit','poll','fetch_result','delete_file','delete_transcription','generate_insights','list_models','test_model','transcribe'));
ALTER TABLE external_calls DROP CONSTRAINT external_calls_provider_check;
ALTER TABLE external_calls ADD CONSTRAINT external_calls_provider_check
 CHECK(provider IN ('soniox','assemblyai','openai_compatible','openai'));
