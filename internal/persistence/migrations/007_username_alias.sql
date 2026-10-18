ALTER TABLE users ADD COLUMN username text UNIQUE CHECK (username=lower(btrim(username)) AND length(username) BETWEEN 2 AND 32 AND username !~ '[@[:space:]]');
WITH candidates AS (
 SELECT id,lower(btrim(display_name)) AS name,count(*) OVER (PARTITION BY lower(btrim(display_name))) AS matches
 FROM users
)
UPDATE users u SET username=c.name FROM candidates c WHERE c.id=u.id AND c.matches=1 AND c.name ~ '^[[:alnum:]_]{2,32}$';
