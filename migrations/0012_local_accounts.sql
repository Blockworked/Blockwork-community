-- Local credentials supplement existing provider IDs; ownership IDs never change.
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN auth_strength TEXT NOT NULL DEFAULT 'legacy';
CREATE TABLE email_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX passkeys_by_user ON passkeys(user_id);
CREATE TABLE backup_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX backup_codes_by_user ON backup_codes(user_id);
-- All bearer secrets are hashed. JSON data never contains passwords or raw tokens.
CREATE TABLE auth_flows (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  auth_version INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_flows_expiry ON auth_flows(expires_at);
CREATE INDEX auth_flows_by_user ON auth_flows(user_id);
CREATE TABLE auth_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_limits_expiry ON auth_limits(expires_at);
-- A code already being exchanged must not survive password reset/session revocation.
ALTER TABLE app_codes ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
