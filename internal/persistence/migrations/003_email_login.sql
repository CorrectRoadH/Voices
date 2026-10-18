DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM users) THEN
  RAISE EXCEPTION 'Email login migration requires explicit email assignment for existing accounts';
 END IF;
END $$;
ALTER TABLE users DROP COLUMN username;
ALTER TABLE users ADD COLUMN email text NOT NULL UNIQUE
 CHECK(length(email) BETWEEN 3 AND 254 AND email=lower(btrim(email)) AND position('@' in email)>1);
