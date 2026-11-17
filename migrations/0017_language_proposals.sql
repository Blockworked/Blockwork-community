-- Languages people ask to translate into (translate.blockworked.com/languages).
CREATE TABLE language_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  -- Kept when the account goes, so the request and its supporters stay.
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'added', 'declined')),
  reply TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
-- One open request per language.
CREATE UNIQUE INDEX language_proposals_open ON language_proposals (lower(code)) WHERE status = 'open';

-- People who said they would help translate a proposed language.
CREATE TABLE language_supporters (
  proposal_id INTEGER NOT NULL REFERENCES language_proposals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, user_id)
);
