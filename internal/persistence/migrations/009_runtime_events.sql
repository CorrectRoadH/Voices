CREATE TABLE runtime_events (
 id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 instance_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('request_failed','job_failed','job_claim_failed','maintenance_failed','job_failure_persistence_failed')),
 code text NOT NULL CHECK(length(code)<=64), request_id uuid, route text CHECK(length(route)<=200),
 status smallint CHECK(status BETWEEN 500 AND 599), job_id uuid
);
CREATE INDEX runtime_events_date ON runtime_events(created_at DESC,id DESC);
CREATE INDEX runtime_events_kind ON runtime_events(kind,created_at DESC,id DESC);
CREATE INDEX runtime_events_request ON runtime_events(request_id,created_at DESC,id DESC) WHERE request_id IS NOT NULL;
CREATE INDEX runtime_events_job ON runtime_events(job_id,created_at DESC,id DESC) WHERE job_id IS NOT NULL;
