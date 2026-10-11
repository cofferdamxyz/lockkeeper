-- A task launched in review mode never merges unattended.
ALTER TABLE tasks ADD COLUMN hold INTEGER NOT NULL DEFAULT 0;
