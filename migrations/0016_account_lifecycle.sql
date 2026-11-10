ALTER TABLE users ADD COLUMN deactivated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0;
-- R2 deletions are retried by the hourly cleanup if storage is unavailable.
CREATE TABLE account_cleanup_objects (object_key TEXT PRIMARY KEY);
-- In-flight requests cannot recreate personal content after the deletion
-- transaction has scrubbed it. Attachment insertion failures remove the R2 file.
CREATE TRIGGER no_deleted_account_tickets BEFORE INSERT ON tickets
WHEN EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at > 0)
BEGIN
  SELECT RAISE(ABORT, 'Account deleted');
END;
CREATE TRIGGER no_deleted_account_ticket_messages BEFORE INSERT ON ticket_messages
WHEN EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at > 0)
  OR EXISTS (SELECT 1 FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = NEW.ticket_id AND u.deleted_at > 0)
BEGIN
  SELECT RAISE(ABORT, 'Account deleted');
END;
CREATE TRIGGER no_deleted_account_attachments BEFORE INSERT ON ticket_attachments
WHEN EXISTS (SELECT 1 FROM ticket_messages m LEFT JOIN users a ON a.id = m.user_id
  JOIN tickets t ON t.id = m.ticket_id LEFT JOIN users u ON u.id = t.user_id
  WHERE m.id = NEW.message_id AND (a.deleted_at > 0 OR u.deleted_at > 0))
BEGIN
  SELECT RAISE(ABORT, 'Account deleted');
END;
CREATE TRIGGER no_deleted_account_comments BEFORE INSERT ON comments
WHEN EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at > 0)
BEGIN
  SELECT RAISE(ABORT, 'Account deleted');
END;
