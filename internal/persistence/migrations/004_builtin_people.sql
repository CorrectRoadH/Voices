ALTER TABLE people ADD COLUMN builtin_key text CHECK (builtin_key IN ('background','music','system_prompt'));
CREATE UNIQUE INDEX people_owner_builtin ON people(owner_id,builtin_key) WHERE builtin_key IS NOT NULL;

CREATE FUNCTION seed_builtin_people() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO people(id,owner_id,display_name,notes,builtin_key)
  SELECT gen_random_uuid(),NEW.id,v.name,'',v.key
  FROM (VALUES ('background','背景声'),('music','音乐'),('system_prompt','系统提示音')) AS v(key,name);
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_seed_builtin_people AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION seed_builtin_people();

INSERT INTO people(id,owner_id,display_name,notes,builtin_key)
SELECT gen_random_uuid(),u.id,v.name,'',v.key FROM users u
CROSS JOIN (VALUES ('background','背景声'),('music','音乐'),('system_prompt','系统提示音')) AS v(key,name);

CREATE FUNCTION protect_builtin_people() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.builtin_key IS DISTINCT FROM OLD.builtin_key OR
     (OLD.builtin_key IS NOT NULL AND
       (NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.archived_at IS DISTINCT FROM OLD.archived_at)) THEN
    RAISE EXCEPTION 'built-in people are read-only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER people_protect_builtin BEFORE UPDATE ON people FOR EACH ROW EXECUTE FUNCTION protect_builtin_people();
