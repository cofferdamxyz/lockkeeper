-- Lockkeeper, the Cofferdam advisory deployment (DESIGN.md §12–§13, workspace decision 0053).
-- Everything here is rebuildable from GitHub except claims, which live for hours at most.

-- One row per repository the GitHub App can see.
CREATE TABLE IF NOT EXISTS repos (
  repo TEXT PRIMARY KEY,               -- owner/name
  default_branch TEXT NOT NULL,
  head_sha TEXT,
  pushed_at TEXT,
  polled_at TEXT
);

-- Branches ahead of the default branch: the work in flight.
CREATE TABLE IF NOT EXISTS branches (
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT,                       -- merge base with the default branch
  ahead INTEGER NOT NULL DEFAULT 0,
  behind INTEGER NOT NULL DEFAULT 0,
  files_json TEXT NOT NULL DEFAULT '[]',
  commits_json TEXT NOT NULL DEFAULT '[]',  -- first lines, newest last
  author TEXT,
  last_commit_at TEXT,
  pr_number INTEGER,
  pr_title TEXT,
  pr_url TEXT,
  pr_draft INTEGER,
  ci TEXT NOT NULL DEFAULT 'none',     -- pass | fail | pending | none
  sensitive_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, name)
);

-- What moved into a default branch, poll to poll.
CREATE TABLE IF NOT EXISTS main_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  before_sha TEXT NOT NULL,
  after_sha TEXT NOT NULL,
  files_json TEXT NOT NULL,
  commits_json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS main_moves_repo_at ON main_moves (repo, at);

-- Claims: "I am about to work here", for the window before a branch is pushed. Never a lock.
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  paths_json TEXT NOT NULL,
  goal TEXT NOT NULL,
  who TEXT NOT NULL,                   -- the Access identity (email or service token name)
  session TEXT,                        -- a label the session gives itself
  branch TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  released_why TEXT
);
CREATE INDEX IF NOT EXISTS claims_repo_expires ON claims (repo, expires_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
