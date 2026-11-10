-- Existing account IDs and ownership stay stable when providers are unlinked.
CREATE TABLE oauth_identities (
  provider TEXT NOT NULL CHECK (provider IN ('github','google')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)
);
INSERT INTO oauth_identities (provider, subject, user_id, label, created_at)
SELECT substr(id,1,instr(id,':')-1), substr(id,instr(id,':')+1), id, name, created_at
FROM users WHERE (id LIKE 'github:%' OR id LIKE 'google:%') AND length(substr(id,instr(id,':')+1)) > 0;

-- During a rolling deployment the previous Worker may still create a provider
-- user after the backfill. Seed its identity atomically so ownership is preserved.
-- This runs only on INSERT, never when an identity is disconnected.
CREATE TRIGGER seed_provider_identity AFTER INSERT ON users
WHEN (NEW.id LIKE 'github:%' OR NEW.id LIKE 'google:%') AND length(substr(NEW.id,instr(NEW.id,':')+1)) > 0
BEGIN
  INSERT INTO oauth_identities (provider,subject,user_id,label,created_at)
  VALUES (substr(NEW.id,1,instr(NEW.id,':')-1),substr(NEW.id,instr(NEW.id,':')+1),NEW.id,NEW.name,NEW.created_at)
  ON CONFLICT DO NOTHING;
END;

ALTER TABLE sessions ADD COLUMN security_unlocked_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN security_last_used_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE email_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  auth_version INTEGER NOT NULL,
  old_email TEXT NOT NULL,
  new_email TEXT NOT NULL,
  old_token_hash TEXT UNIQUE,
  new_token_hash TEXT UNIQUE,
  cancel_token_hash TEXT NOT NULL UNIQUE,
  old_confirmed INTEGER NOT NULL DEFAULT 0,
  new_confirmed INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX email_changes_expiry ON email_changes(expires_at);
CREATE TABLE account_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX account_security_events_by_user ON account_security_events(user_id, id);
