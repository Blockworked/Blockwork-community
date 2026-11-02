-- The helpdesk at support.blockworked.com. A ticket comes from a signed-in
-- account or an email to support@; whoever filed it reads it with its key.
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  -- open: waiting on staff; answered: waiting on the requester; closed.
  status TEXT NOT NULL DEFAULT 'open',
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  user_id TEXT REFERENCES users(id),
  -- The secret in the links emailed to the requester, which open the ticket without an account.
  access_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX tickets_by_status ON tickets(status, updated_at);
CREATE INDEX tickets_by_user ON tickets(user_id, updated_at);
CREATE INDEX tickets_by_email ON tickets(email, created_at);

CREATE TABLE ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  -- requester, staff, or note (staff only, never emailed).
  kind TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  body TEXT NOT NULL,
  -- Message-ID of the email this came in as or went out as, so replies thread.
  email_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX ticket_messages_by_ticket ON ticket_messages(ticket_id, created_at);
CREATE INDEX ticket_messages_by_email_id ON ticket_messages(email_id);

-- The address a signed-in account last filed a ticket under, to fill the form in.
ALTER TABLE users ADD COLUMN support_email TEXT;
