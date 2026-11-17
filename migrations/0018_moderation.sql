-- Spam prevention and moderation (src/moderation.ts, src/moderation-admin.ts).

-- A shadowbanned account can still post, but only it sees what it posts.
ALTER TABLE users ADD COLUMN shadowbanned INTEGER NOT NULL DEFAULT 0;
-- A keyed hash of the network address an account last posted from. Never the address itself.
ALTER TABLE users ADD COLUMN ip_hash TEXT;

-- Held comments wait for an admin; removed ones were taken down by moderation
-- (deleted_at stays the writer's own delete), so a rollback can put them back.
ALTER TABLE comments ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN removed_at INTEGER;
ALTER TABLE comments ADD COLUMN ip_hash TEXT;
ALTER TABLE versions ADD COLUMN ip_hash TEXT;
ALTER TABLE tickets ADD COLUMN ip_hash TEXT;
ALTER TABLE language_proposals ADD COLUMN ip_hash TEXT;

CREATE INDEX comments_held ON comments(held, created_at);
CREATE INDEX comments_by_time ON comments(created_at);
CREATE INDEX comments_by_ip ON comments(ip_hash);
CREATE INDEX versions_by_ip ON versions(ip_hash);
CREATE INDEX tickets_by_ip ON tickets(ip_hash);
CREATE INDEX users_by_ip ON users(ip_hash);
CREATE INDEX users_by_created ON users(created_at);

-- Site-wide switches, like lockdown: off, new (new accounts can't post) or all.
CREATE TABLE moderation_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

-- Refused senders: ip (a keyed hash), email (an address) or domain.
CREATE TABLE blocklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('ip', 'email', 'domain')),
  value TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE UNIQUE INDEX blocklist_value ON blocklist(kind, value);

-- Every moderation action, who took it, and whether it was undone.
CREATE TABLE moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  undone_at INTEGER,
  undone_by TEXT
);
CREATE INDEX moderation_log_by_time ON moderation_log(created_at);
CREATE INDEX moderation_log_by_target ON moderation_log(target_kind, target_id);

-- What one logged action changed, with each row's values before, so it can be undone.
CREATE TABLE moderation_changes (
  log_id INTEGER NOT NULL REFERENCES moderation_log(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  before TEXT NOT NULL,
  PRIMARY KEY (log_id, kind, item_id)
);

-- Reports from signed-in people about a comment or a pack.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'pack')),
  item_id TEXT NOT NULL,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE UNIQUE INDEX reports_once ON reports(kind, item_id, reporter_id) WHERE resolved_at IS NULL;
CREATE INDEX reports_open ON reports(resolved_at, created_at);
