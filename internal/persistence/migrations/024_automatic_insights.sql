-- @concord-file
-- @concord-implements docs/feature/insights/architecture.md
ALTER TABLE jobs ADD COLUMN auto_insights_suppressed boolean NOT NULL DEFAULT false;
