ALTER TABLE external_calls DROP CONSTRAINT external_calls_provider_check;
ALTER TABLE external_calls ADD CONSTRAINT external_calls_provider_check
 CHECK(provider IN ('soniox','assemblyai','openai_compatible','openai','elevenlabs'));
