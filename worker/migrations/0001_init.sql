-- Lockkeeper ledger. Everything here is rebuildable state about work in flight.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  remote TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  head_sha TEXT,
  basis_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects(id),
  goal TEXT NOT NULL,
  brief TEXT,
  fork TEXT,
  fork_remote TEXT,
  status TEXT NOT NULL,
  base_sha TEXT,
  head_sha TEXT,
  files_json TEXT,
  diffstat TEXT,
  diff TEXT,
  commits_json TEXT,
  tests_ok INTEGER,
  summary TEXT,
  events_tail TEXT,
  error TEXT,
  cost_usd REAL,
  restarts INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS tasks_project_status ON tasks(project, status);

CREATE TABLE IF NOT EXISTS pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  project TEXT,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  before_sha TEXT,
  after_sha TEXT,
  commits_json TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  chosen TEXT,
  error TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS merges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  project TEXT NOT NULL,
  decision_id TEXT,
  mode TEXT NOT NULL,
  main_before TEXT,
  main_after TEXT,
  conflict INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  approved_by TEXT,
  output TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  dedupe TEXT UNIQUE,
  payload_json TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Projected coordinates for the dashboard: files and task revisions on one fixed basis.
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'file' | 'task'
  label TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  meta_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS positions_project ON positions(project, kind);

-- Short-lived Artifacts tokens the outbound gateway injects for a named sandbox.
CREATE TABLE IF NOT EXISTS tokens (
  sandbox TEXT NOT NULL,
  repo TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (sandbox, repo)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per project while a merge Workflow instance is running.
CREATE TABLE IF NOT EXISTS leases (
  project TEXT PRIMARY KEY,
  instance TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
