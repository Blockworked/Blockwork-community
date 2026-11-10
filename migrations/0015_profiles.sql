-- Handles are opt-in; provider names are never silently claimed for existing users.
ALTER TABLE users ADD COLUMN username TEXT COLLATE NOCASE
  CHECK (username IS NULL OR (length(username) BETWEEN 3 AND 30 AND username NOT GLOB '*[^a-z0-9_]*' AND substr(username,1,1) GLOB '[a-z]'));
CREATE UNIQUE INDEX users_username ON users(username COLLATE NOCASE);
ALTER TABLE users ADD COLUMN username_changed_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE username_history (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES users(id),
  hold_until INTEGER NOT NULL
);
-- Old handles remain reserved to their owner for 90 days after release.
CREATE TRIGGER reserve_released_username AFTER UPDATE OF username ON users
WHEN OLD.username IS NOT NULL AND OLD.username IS NOT NEW.username
BEGIN
  INSERT INTO username_history (username,user_id,hold_until) VALUES (OLD.username,NEW.id,NEW.username_changed_at + 7776000000)
  ON CONFLICT(username) DO UPDATE SET user_id = excluded.user_id, hold_until = excluded.hold_until;
END;
CREATE TABLE profile_pictures (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  id TEXT NOT NULL UNIQUE,
  png TEXT NOT NULL
);
