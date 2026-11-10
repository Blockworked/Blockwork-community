-- Images live in private R2 keys; downloads check the parent ticket and message.
CREATE TABLE ticket_attachments (
  id TEXT PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES ticket_messages(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL
);
CREATE INDEX ticket_attachments_by_message ON ticket_attachments(message_id);
