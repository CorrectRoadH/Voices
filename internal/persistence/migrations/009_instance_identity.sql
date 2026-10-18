-- @concord-implements docs/feature/updates/use-case/check-updates.md
CREATE TABLE instance_identity (
  id smallint PRIMARY KEY CHECK (id = 1),
  instance_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
INSERT INTO instance_identity (id) VALUES (1) ON CONFLICT DO NOTHING;
