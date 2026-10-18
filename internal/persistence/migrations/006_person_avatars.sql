ALTER TABLE people ADD COLUMN avatar_png bytea CHECK (octet_length(avatar_png) <= 524288);
ALTER TABLE people ADD COLUMN avatar_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE people ADD CONSTRAINT builtin_no_avatar CHECK (builtin_key IS NULL OR avatar_png IS NULL);
