-- A language request is for one translation project, not all of them.
ALTER TABLE language_proposals ADD COLUMN component TEXT NOT NULL DEFAULT '';
-- Requests made before this were shown under the app, which is what people asked about.
UPDATE language_proposals SET component = 'blockwork/ui' WHERE component = '';
DROP INDEX language_proposals_open;
-- One open request per language in each project.
CREATE UNIQUE INDEX language_proposals_open ON language_proposals (component, lower(code)) WHERE status = 'open';
