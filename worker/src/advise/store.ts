import type { AdviseEnv } from "./env";

export interface BranchRow {
  repo: string;
  name: string;
  head_sha: string;
  base_sha: string | null;
  ahead: number;
  behind: number;
  files: string[];
  commits: string[];
  author: string | null;
  last_commit_at: string | null;
  pr_number: number | null;
  pr_title: string | null;
  pr_url: string | null;
  pr_draft: boolean;
  ci: string;
  sensitive: string[];
  updated_at: string;
}

export interface ClaimRow {
  id: string;
  repo: string;
  paths: string[];
  goal: string;
  who: string;
  session: string | null;
  branch: string | null;
  created_at: string;
  expires_at: string;
  released_at: string | null;
}

export interface MainMove {
  repo: string;
  before_sha: string;
  after_sha: string;
  files: string[];
  commits: string[];
  at: string;
}

export interface RepoRow {
  repo: string;
  default_branch: string;
  head_sha: string | null;
  pushed_at: string | null;
  polled_at: string | null;
}

const parse = (s: unknown): string[] => {
  try {
    const v = JSON.parse(String(s ?? "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

function toBranch(r: Record<string, unknown>): BranchRow {
  return {
    repo: String(r.repo),
    name: String(r.name),
    head_sha: String(r.head_sha),
    base_sha: (r.base_sha as string | null) ?? null,
    ahead: Number(r.ahead ?? 0),
    behind: Number(r.behind ?? 0),
    files: parse(r.files_json),
    commits: parse(r.commits_json),
    author: (r.author as string | null) ?? null,
    last_commit_at: (r.last_commit_at as string | null) ?? null,
    pr_number: r.pr_number == null ? null : Number(r.pr_number),
    pr_title: (r.pr_title as string | null) ?? null,
    pr_url: (r.pr_url as string | null) ?? null,
    pr_draft: Boolean(r.pr_draft),
    ci: String(r.ci ?? "none"),
    sensitive: parse(r.sensitive_json),
    updated_at: String(r.updated_at),
  };
}

function toClaim(r: Record<string, unknown>): ClaimRow {
  return {
    id: String(r.id),
    repo: String(r.repo),
    paths: parse(r.paths_json),
    goal: String(r.goal),
    who: String(r.who),
    session: (r.session as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    created_at: String(r.created_at),
    expires_at: String(r.expires_at),
    released_at: (r.released_at as string | null) ?? null,
  };
}

export async function getRepos(env: Pick<AdviseEnv, "DB">): Promise<RepoRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM repos ORDER BY repo").all<RepoRow>();
  return results;
}

export async function getRepo(env: Pick<AdviseEnv, "DB">, repo: string): Promise<RepoRow | null> {
  return env.DB.prepare("SELECT * FROM repos WHERE repo = ?").bind(repo).first<RepoRow>();
}

export async function putRepo(env: Pick<AdviseEnv, "DB">, r: RepoRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (repo, default_branch, head_sha, pushed_at, polled_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET default_branch = excluded.default_branch, head_sha = excluded.head_sha,
       pushed_at = excluded.pushed_at, polled_at = excluded.polled_at`,
  )
    .bind(r.repo, r.default_branch, r.head_sha, r.pushed_at, r.polled_at)
    .run();
}

export async function deleteRepo(env: Pick<AdviseEnv, "DB">, repo: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM repos WHERE repo = ?").bind(repo),
    env.DB.prepare("DELETE FROM branches WHERE repo = ?").bind(repo),
  ]);
}

export async function getBranches(env: Pick<AdviseEnv, "DB">, repo?: string): Promise<BranchRow[]> {
  const stmt = repo
    ? env.DB.prepare("SELECT * FROM branches WHERE repo = ? ORDER BY last_commit_at DESC").bind(repo)
    : env.DB.prepare("SELECT * FROM branches ORDER BY repo, last_commit_at DESC");
  const { results } = await stmt.all<Record<string, unknown>>();
  return results.map(toBranch);
}

export async function putBranch(env: Pick<AdviseEnv, "DB">, b: BranchRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO branches (repo, name, head_sha, base_sha, ahead, behind, files_json, commits_json, author,
       last_commit_at, pr_number, pr_title, pr_url, pr_draft, ci, sensitive_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, name) DO UPDATE SET head_sha = excluded.head_sha, base_sha = excluded.base_sha,
       ahead = excluded.ahead, behind = excluded.behind, files_json = excluded.files_json,
       commits_json = excluded.commits_json, author = excluded.author, last_commit_at = excluded.last_commit_at,
       pr_number = excluded.pr_number, pr_title = excluded.pr_title, pr_url = excluded.pr_url,
       pr_draft = excluded.pr_draft, ci = excluded.ci, sensitive_json = excluded.sensitive_json,
       updated_at = excluded.updated_at`,
  )
    .bind(
      b.repo,
      b.name,
      b.head_sha,
      b.base_sha,
      b.ahead,
      b.behind,
      JSON.stringify(b.files),
      JSON.stringify(b.commits),
      b.author,
      b.last_commit_at,
      b.pr_number,
      b.pr_title,
      b.pr_url,
      b.pr_draft ? 1 : 0,
      b.ci,
      JSON.stringify(b.sensitive),
      b.updated_at,
    )
    .run();
}

export async function deleteBranch(env: Pick<AdviseEnv, "DB">, repo: string, name: string): Promise<void> {
  await env.DB.prepare("DELETE FROM branches WHERE repo = ? AND name = ?").bind(repo, name).run();
}

export async function addMainMove(env: Pick<AdviseEnv, "DB">, m: MainMove): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO main_moves (repo, before_sha, after_sha, files_json, commits_json, at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(m.repo, m.before_sha, m.after_sha, JSON.stringify(m.files), JSON.stringify(m.commits), m.at)
    .run();
}

export async function recentMainMoves(env: Pick<AdviseEnv, "DB">, repo: string, sinceIso: string): Promise<MainMove[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM main_moves WHERE repo = ? AND at >= ? ORDER BY at DESC LIMIT 20",
  )
    .bind(repo, sinceIso)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    repo: String(r.repo),
    before_sha: String(r.before_sha),
    after_sha: String(r.after_sha),
    files: parse(r.files_json),
    commits: parse(r.commits_json),
    at: String(r.at),
  }));
}

export async function addClaim(env: Pick<AdviseEnv, "DB">, c: ClaimRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO claims (id, repo, paths_json, goal, who, session, branch, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(c.id, c.repo, JSON.stringify(c.paths), c.goal, c.who, c.session, c.branch, c.created_at, c.expires_at)
    .run();
}

export async function getClaim(env: Pick<AdviseEnv, "DB">, id: string): Promise<ClaimRow | null> {
  const r = await env.DB.prepare("SELECT * FROM claims WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return r ? toClaim(r) : null;
}

export async function activeClaims(env: Pick<AdviseEnv, "DB">, nowIso: string, repo?: string): Promise<ClaimRow[]> {
  const stmt = repo
    ? env.DB.prepare("SELECT * FROM claims WHERE repo = ? AND released_at IS NULL AND expires_at > ? ORDER BY created_at").bind(repo, nowIso)
    : env.DB.prepare("SELECT * FROM claims WHERE released_at IS NULL AND expires_at > ? ORDER BY repo, created_at").bind(nowIso);
  const { results } = await stmt.all<Record<string, unknown>>();
  return results.map(toClaim);
}

export async function renewClaim(env: Pick<AdviseEnv, "DB">, id: string, expiresIso: string, nowIso: string): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE claims SET expires_at = ? WHERE id = ? AND released_at IS NULL AND expires_at > ?")
    .bind(expiresIso, id, nowIso)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function releaseClaim(env: Pick<AdviseEnv, "DB">, id: string, why: string, nowIso: string): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE claims SET released_at = ?, released_why = ? WHERE id = ? AND released_at IS NULL")
    .bind(nowIso, why, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** A claim naming a branch is done once that branch is on GitHub: the branch speaks for itself. */
export async function releaseClaimsForBranch(env: Pick<AdviseEnv, "DB">, repo: string, branch: string, nowIso: string): Promise<number> {
  const res = await env.DB.prepare(
    "UPDATE claims SET released_at = ?, released_why = 'pushed' WHERE repo = ? AND branch = ? AND released_at IS NULL",
  )
    .bind(nowIso, repo, branch)
    .run();
  return res.meta.changes ?? 0;
}

/** Expired and released claims older than a day carry no information. */
export async function pruneClaims(env: Pick<AdviseEnv, "DB">, beforeIso: string): Promise<void> {
  await env.DB.prepare("DELETE FROM claims WHERE expires_at < ? OR released_at < ?").bind(beforeIso, beforeIso).run();
}

export async function pruneMainMoves(env: Pick<AdviseEnv, "DB">, beforeIso: string): Promise<void> {
  await env.DB.prepare("DELETE FROM main_moves WHERE at < ?").bind(beforeIso).run();
}

export async function getSetting(env: Pick<AdviseEnv, "DB">, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(env: Pick<AdviseEnv, "DB">, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

/** A lease so the cron and a manual poll never run over each other. */
export async function takeLease(env: Pick<AdviseEnv, "DB">, key: string, nowMs: number, ttlMs: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) < ?`,
  )
    .bind(key, String(nowMs + ttlMs), nowMs)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function dropLease(env: Pick<AdviseEnv, "DB">, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

// ---------- advice (step 3 of DESIGN.md §13) ----------

export interface AdviceRow {
  repo: string;
  branch: string;
  pr_number: number;
  head_sha: string;
  position: number;
  next_p: number | null;
  unattended: number | null;
  risk: number | null;
  eligible: boolean;
  reasons: string[];
  label: string | null;
  issue: string | null;
  body: string;
  comment_id: number | null;
  comment_hash: string | null;
  decision_id: string | null;
  decided_at: string;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

function toAdvice(r: Record<string, unknown>): AdviceRow {
  return {
    repo: String(r.repo),
    branch: String(r.branch),
    pr_number: Number(r.pr_number),
    head_sha: String(r.head_sha),
    position: Number(r.position),
    next_p: num(r.next_p),
    unattended: num(r.unattended),
    risk: num(r.risk),
    eligible: Boolean(r.eligible),
    reasons: parse(r.reasons_json),
    label: (r.label as string | null) ?? null,
    issue: (r.issue as string | null) ?? null,
    body: String(r.body),
    comment_id: num(r.comment_id),
    comment_hash: (r.comment_hash as string | null) ?? null,
    decision_id: (r.decision_id as string | null) ?? null,
    decided_at: String(r.decided_at),
  };
}

export async function getAdvice(env: Pick<AdviseEnv, "DB">, repo?: string): Promise<AdviceRow[]> {
  const stmt = repo
    ? env.DB.prepare("SELECT * FROM advice WHERE repo = ? ORDER BY position").bind(repo)
    : env.DB.prepare("SELECT * FROM advice ORDER BY repo, position");
  const { results } = await stmt.all<Record<string, unknown>>();
  return results.map(toAdvice);
}

/** Replaces a repository's advice in one batch; the comment a row already has stays with it. */
export async function replaceAdvice(env: Pick<AdviseEnv, "DB">, repo: string, rows: AdviceRow[]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM advice WHERE repo = ?").bind(repo),
    ...rows.map((a) =>
      env.DB.prepare(
        `INSERT INTO advice (repo, branch, pr_number, head_sha, position, next_p, unattended, risk, eligible, reasons_json,
           label, issue, body, comment_id, comment_hash, decision_id, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        a.repo,
        a.branch,
        a.pr_number,
        a.head_sha,
        a.position,
        a.next_p,
        a.unattended,
        a.risk,
        a.eligible ? 1 : 0,
        JSON.stringify(a.reasons),
        a.label,
        a.issue,
        a.body,
        a.comment_id,
        a.comment_hash,
        a.decision_id,
        a.decided_at,
      ),
    ),
  ]);
}

export async function setAdviceComment(env: Pick<AdviseEnv, "DB">, repo: string, branch: string, id: number, hash: string): Promise<void> {
  await env.DB.prepare("UPDATE advice SET comment_id = ?, comment_hash = ? WHERE repo = ? AND branch = ?").bind(id, hash, repo, branch).run();
}

export async function addDecision(
  env: Pick<AdviseEnv, "DB">,
  d: { id: string; repo: string; candidates: string[]; request: unknown; response: unknown; error: string | null; at: string },
): Promise<void> {
  await env.DB.prepare("INSERT INTO decisions (id, repo, candidates_json, request_json, response_json, error, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(d.id, d.repo, JSON.stringify(d.candidates), d.request == null ? null : JSON.stringify(d.request), d.response == null ? null : JSON.stringify(d.response), d.error, d.at)
    .run();
}

export async function pruneDecisions(env: Pick<AdviseEnv, "DB">, beforeIso: string): Promise<void> {
  await env.DB.prepare("DELETE FROM decisions WHERE at < ?").bind(beforeIso).run();
}

export interface Outcome {
  repo: string;
  pr_number: number;
  head_sha: string;
  position: number;
  candidates: number;
  unattended: number | null;
  risk: number | null;
  eligible: boolean;
  outcome: "landed" | "closed" | "unknown";
  at: string;
}

export async function addOutcome(env: Pick<AdviseEnv, "DB">, o: Outcome): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO outcomes (repo, pr_number, head_sha, position, candidates, unattended, risk, eligible, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(o.repo, o.pr_number, o.head_sha, o.position, o.candidates, o.unattended, o.risk, o.eligible ? 1 : 0, o.outcome, o.at)
    .run();
}

export async function getOutcomes(env: Pick<AdviseEnv, "DB">, repo?: string, limit = 200): Promise<Outcome[]> {
  const stmt = repo
    ? env.DB.prepare("SELECT * FROM outcomes WHERE repo = ? ORDER BY at DESC LIMIT ?").bind(repo, limit)
    : env.DB.prepare("SELECT * FROM outcomes ORDER BY at DESC LIMIT ?").bind(limit);
  const { results } = await stmt.all<Record<string, unknown>>();
  return results.map((r) => ({
    repo: String(r.repo),
    pr_number: Number(r.pr_number),
    head_sha: String(r.head_sha),
    position: Number(r.position),
    candidates: Number(r.candidates),
    unattended: num(r.unattended),
    risk: num(r.risk),
    eligible: Boolean(r.eligible),
    outcome: String(r.outcome) as Outcome["outcome"],
    at: String(r.at),
  }));
}
