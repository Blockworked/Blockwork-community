-- TOTP secrets must be recoverable for HMAC verification, so encrypt them with
-- an external Worker secret. Database access alone cannot recover those seeds.
CREATE TABLE totp_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  encrypted_secret TEXT NOT NULL,
  last_step INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE support_recovery_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL REFERENCES users(id),
  target_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK(action IN ('lookup', 'reset_email', 'revoke')),
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX support_recovery_audit_by_target ON support_recovery_audit(target_id, created_at);
