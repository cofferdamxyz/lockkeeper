import type { LockkeeperEnv } from "./env";

export type TaskStatus =
  | "queued"
  | "running"
  | "ready"
  | "merging"
  | "merged"
  | "needs_review"
  | "approved"
  | "blocked"
  | "failed"
  | "abandoned";

export interface TaskRow {
  id: string;
  project: string;
  goal: string;
  brief: string | null;
  fork: string | null;
  fork_remote: string | null;
  status: TaskStatus;
  base_sha: string | null;
  head_sha: string | null;
  files_json: string | null;
  diffstat: string | null;
  diff: string | null;
  commits_json: string | null;
  tests_ok: number | null;
  summary: string | null;
  events_tail: string | null;
  error: string | null;
  cost_usd: number | null;
  restarts: number;
  resolved: number;
  hold: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  repo: string;
  remote: string | null;
  default_branch: string;
  head_sha: string | null;
  basis_json: string | null;
}

export function newId(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}

export const now = () => new Date().toISOString();

export async function getProject(db: D1Database, id: string): Promise<ProjectRow | null> {
  return db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
}

export async function upsertProject(
  db: D1Database,
  p: { id: string; repo: string; remote?: string; default_branch: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO projects (id, repo, remote, default_branch) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET repo = excluded.repo,
         remote = COALESCE(excluded.remote, projects.remote),
         default_branch = excluded.default_branch, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(p.id, p.repo, p.remote ?? null, p.default_branch)
    .run();
}

export async function getTask(db: D1Database, id: string): Promise<TaskRow | null> {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
}

export async function listTasks(db: D1Database, project: string, statuses?: TaskStatus[]): Promise<TaskRow[]> {
  if (statuses && statuses.length > 0) {
    const marks = statuses.map(() => "?").join(",");
    const r = await db
      .prepare(`SELECT * FROM tasks WHERE project = ? AND status IN (${marks}) ORDER BY created_at`)
      .bind(project, ...statuses)
      .all<TaskRow>();
    return r.results;
  }
  const r = await db.prepare("SELECT * FROM tasks WHERE project = ? ORDER BY created_at").bind(project).all<TaskRow>();
  return r.results;
}

export async function updateTask(
  db: D1Database,
  id: string,
  patch: Partial<Omit<TaskRow, "id" | "created_at">>,
): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch[k] === undefined ? null : (patch[k] as unknown)));
  await db
    .prepare(`UPDATE tasks SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
    .bind(...values, id)
    .run();
  if (patch.status) await recordStatus(db, id, patch.status);
}

/** Every status change is an event, so the timeline can replay a run. */
export async function recordStatus(db: D1Database, taskId: string, status: TaskStatus): Promise<void> {
  await db
    .prepare("INSERT INTO events (type, dedupe, payload_json) VALUES ('task.status', NULL, ?)")
    .bind(JSON.stringify({ task: taskId, status }))
    .run();
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(key, value)
    .run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

/** Store a repository token the outbound gateway may inject for one named sandbox. */
export async function putToken(
  db: D1Database,
  sandbox: string,
  repo: string,
  token: string,
  expiresAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tokens (sandbox, repo, token, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(sandbox, repo) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`,
    )
    .bind(sandbox, repo, token, expiresAt)
    .run();
}

export async function getToken(db: D1Database, sandbox: string, repo: string): Promise<string | null> {
  const r = await db
    .prepare("SELECT token, expires_at FROM tokens WHERE sandbox = ? AND repo = ?")
    .bind(sandbox, repo)
    .first<{ token: string; expires_at: string }>();
  if (!r) return null;
  if (new Date(r.expires_at).getTime() < Date.now() + 15_000) return null;
  return r.token;
}

export async function recordEvent(db: D1Database, type: string, dedupe: string | null, payload: unknown): Promise<boolean> {
  try {
    await db
      .prepare("INSERT INTO events (type, dedupe, payload_json) VALUES (?, ?, ?)")
      .bind(type, dedupe, JSON.stringify(payload))
      .run();
    return true;
  } catch (e) {
    if (String(e).includes("UNIQUE")) return false;
    throw e;
  }
}

export async function acquireLease(db: D1Database, project: string, instance: string): Promise<boolean> {
  try {
    await db.prepare("INSERT INTO leases (project, instance) VALUES (?, ?)").bind(project, instance).run();
    return true;
  } catch (e) {
    if (String(e).includes("UNIQUE") || String(e).includes("PRIMARY")) return false;
    throw e;
  }
}

export async function releaseLease(db: D1Database, project: string, instance: string): Promise<void> {
  await db.prepare("DELETE FROM leases WHERE project = ? AND instance = ?").bind(project, instance).run();
}

export type Db = LockkeeperEnv["DB"];
