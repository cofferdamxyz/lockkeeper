-- Step 3 of DESIGN.md §13: Clef's advice per candidate pull request and the landing order.

-- The advice in force, one row per candidate pull request. Rebuilt whenever the candidates move.
CREATE TABLE IF NOT EXISTS advice (
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  position INTEGER NOT NULL,           -- 1 lands first, within the repository
  next_p REAL,                         -- Clef's probability that this one lands next (null: one candidate, or no Clef)
  unattended REAL,                     -- Clef's P(yes) for "may land with no review" (null: no Clef)
  risk REAL,                           -- probability-weighted, 0 none .. 3 critical (null: no Clef)
  eligible INTEGER NOT NULL DEFAULT 0, -- unattended-eligible: Clef's answers and every rule agree
  reasons_json TEXT NOT NULL DEFAULT '[]',  -- why it is not eligible
  label TEXT,                          -- a label suggestion (`security`), never applied by Lockkeeper
  issue TEXT,                          -- owner/repo#n, bound by the branch name
  body TEXT NOT NULL,                  -- the comment as it should read
  comment_id INTEGER,                  -- the comment on GitHub, once written
  comment_hash TEXT,                   -- hash of the body last written there
  decision_id TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (repo, branch)
);

-- The decision ledger: every request to Clef with its answer, as the demo keeps it.
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  request_json TEXT,
  response_json TEXT,
  error TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_repo_at ON decisions (repo, at);

-- Calibration: what the advice said when a candidate left, and what happened to it.
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  position INTEGER NOT NULL,
  candidates INTEGER NOT NULL,         -- how many were open beside it
  unattended REAL,
  risk REAL,
  eligible INTEGER NOT NULL,
  outcome TEXT NOT NULL,               -- landed | closed | unknown
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outcomes_repo_at ON outcomes (repo, at);
