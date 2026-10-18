ALTER TABLE people ADD COLUMN is_self boolean NOT NULL DEFAULT false;
ALTER TABLE people ADD CONSTRAINT builtin_not_self CHECK (builtin_key IS NULL OR NOT is_self);
CREATE UNIQUE INDEX people_one_self_per_owner ON people(owner_id) WHERE is_self;
