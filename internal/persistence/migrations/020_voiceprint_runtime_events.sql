-- Local inference belongs to runtime logs, not paid/external call accounting.
ALTER TABLE runtime_events DROP CONSTRAINT runtime_events_kind_check;
ALTER TABLE runtime_events ADD CONSTRAINT runtime_events_kind_check CHECK(kind IN (
 'request_failed','job_failed','job_claim_failed','maintenance_failed','job_failure_persistence_failed',
 'voiceprint_started','voiceprint_completed','voiceprint_failed',
 'voiceprint_claim_failed','voiceprint_cleanup_failed','voiceprint_failure_persistence_failed'
));
