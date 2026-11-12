import config, { type AdviseConfig, type LockkeeperConfig } from "../../../lockkeeper.config";
import { parseMergeDecision, RISK_LEVELS, type ClefQuestion, type ClefRequest } from "../clef";
import { cosine, jaccard } from "../vectors";
import type { AdviseEnv } from "./env";
import { ADVICE_MARKER, GitHub, GitHubError, type Fetch } from "./github";
import { issueFromBranch } from "./issues";
import { sharedPaths } from "./paths";
import {
  addDecision,
  addOutcome,
  dropLease,
  getAdvice,
  getBranches,
  getRepos,
  getSetting,
  pruneDecisions,
  recentMainMoves,
  replaceAdvice,
  setAdviceComment,
  setSetting,
  takeLease,
  type AdviceRow,
  type BranchRow,
  type MainMove,
  type Outcome,
} from "./store";
import { branchText, embedTexts } from "./vectorIndex";

/**
 * The advising pass (DESIGN.md §13 step 3): Clef over the open pull requests of each repository.
 * It answers three things per candidate (which lands next, may it land unattended, how risky is
 * it to the others), from which come one landing order per repository and one comment per pull
 * request. Clef returns choices and probabilities, never prose; the rules below are plain code.
 * Nothing is merged, opened, labelled or closed here: the one write is the comment.
 *
 * It runs in the cron after the poll rather than as a Workflow binding, because this deployment
 * binds no runner (the guard test); a repository is asked again only when its candidates moved.
 */

export const MARKER = ADVICE_MARKER;
const LEASE = "advise_lease";
const BLOCKED = "advice_comments_blocked_until";
const MAX_WRITES = 40;
/** After Clef fails or answers in part, a repository is not asked again for this long. */
const RETRY_MS = 30 * 60_000;
const MAX_STATE_CHARS = 150_000;

export type Clef = (request: ClefRequest) => Promise<unknown>;

export interface AdviseReport {
  repos: number;
  asked: number;
  candidates: number;
  comments: number;
  outcomes: number;
  errors: string[];
  skipped?: string;
}

export interface AdviseOptions {
  fetcher?: Fetch;
  now?: () => Date;
  settings?: AdviseConfig;
  thresholds?: LockkeeperConfig["clef"];
  /** Tests pass a fake; the deployment asks Workers AI. */
  clef?: Clef | null;
  /** Ask again even where nothing moved. */
  force?: boolean;
}

const prId = (n: number) => `pr-${n}`;

async function sha256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * A path as it may appear in a comment or a request. Git allows any byte in a file name, and a
 * pull request chooses its own: anything outside a plain path alphabet becomes `?`, so a name can
 * neither close its code span nor write a line, a mention or a marker of its own.
 */
export function safePath(p: string): string {
  return p.replace(/[^A-Za-z0-9._\-/ +=,()#~]/g, "?").slice(0, 160);
}

function tick(xs: string[], max = 4): string {
  const shown = xs.slice(0, max).map((x) => `\`${safePath(x)}\``).join(", ");
  return xs.length > max ? `${shown} and ${xs.length - max} more` : shown;
}

interface Overlap {
  with: number;
  cosine: number;
  paths: number;
  shared: string[];
}

interface Candidate {
  branch: BranchRow;
  number: number;
  ageMinutes: number;
  overlaps: Overlap[];
  /** Files it changes that the default branch changed after its base. */
  stale: string[];
  /** Behind the default branch from a base older than the record of its moves: what changed under it is not known. */
  baseUnknown: boolean;
}

/** The branches with an open pull request, oldest first; past `max` the newest wait for a later round. */
export function openPulls(branches: BranchRow[], max: number): BranchRow[] {
  return branches
    .filter((b) => b.pr_number !== null)
    .sort((a, b) => (a.last_commit_at ?? "").localeCompare(b.last_commit_at ?? "") || a.name.localeCompare(b.name))
    .slice(0, max);
}

/** The candidates with their overlap on each other (one embedding call when Workers AI is bound). */
export async function candidatesOf(env: Pick<AdviseEnv, "AI">, open: BranchRow[], recent: MainMove[], now: Date): Promise<Candidate[]> {
  const vectors = open.length > 1 ? await embedTexts(env, open.map(branchText)).catch(() => [] as number[][]) : [];
  return open.map((b, i) => {
    const moved = movedSince(b.base_sha, recent);
    return {
    branch: b,
    number: b.pr_number as number,
    ageMinutes: b.last_commit_at ? Math.max(0, Math.round((now.getTime() - Date.parse(b.last_commit_at)) / 60_000)) : 0,
    overlaps: open
      .map((o, k) => ({ o, k }))
      .filter(({ k }) => k !== i)
      .map(({ o, k }) => ({
        with: o.pr_number as number,
        cosine: vectors[i] && vectors[k] ? Number(cosine(vectors[i], vectors[k]).toFixed(3)) : 0,
        paths: Number(jaccard(b.files, o.files).toFixed(3)),
        shared: sharedPaths(b.files, o.files),
      })),
    stale: b.behind > 0 ? sharedPaths(b.files, moved.files) : [],
    baseUnknown: b.behind > 0 && !moved.found,
    };
  });
}

/**
 * Files the default branch changed after `base`. `recent` is newest first; the walk stops at the
 * move that ended on the base (`found`). A base inside a move counts that move too. A base older
 * than the record, or before the first poll, is not found: the files are then only what the
 * record holds, and the caller must not read their absence as "nothing moved".
 */
export function movedSince(base: string | null, recent: MainMove[]): { files: string[]; found: boolean } {
  const files = new Set<string>();
  for (const m of recent) {
    if (base && m.after_sha === base) return { files: [...files], found: true };
    for (const f of m.files) files.add(f);
    if (base && m.before_sha === base) return { files: [...files], found: true };
  }
  return { files: [...files], found: false };
}

function summarize(c: Candidate): string {
  const b = c.branch;
  const overlap = c.overlaps
    .filter((o) => o.shared.length || o.cosine >= 0.5)
    .map((o) => `#${o.with} (${o.shared.length} shared files, cos ${o.cosine.toFixed(2)})`)
    .join("; ");
  return [
    cut(b.pr_title ?? b.name, 160),
    `${b.files.length} files, ${b.ahead} commits, ${b.behind} behind`,
    b.ci === "pass" ? "CI green" : b.ci === "fail" ? "CI red" : b.ci === "pending" ? "CI running on an older head" : "no CI result",
    overlap ? `overlaps ${overlap}` : "no overlap",
    b.sensitive.length ? "touches sensitive paths" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** The request to Clef: the demo's three questions (DESIGN.md §6), over pull requests instead of forks. */
export function buildAdviceRequest(repo: string, candidates: Candidate[], recent: MainMove[], model: ClefRequest["model"], settings: AdviseConfig): ClefRequest {
  // A pull request chooses its own file names, titles and commit messages: each is cut and the
  // whole state is bounded, so no change can crowd the others out of the request.
  let state = buildState(repo, candidates, recent, settings, 100);
  if (state.length > MAX_STATE_CHARS) state = buildState(repo, candidates, recent, settings, 15);
  if (state.length > MAX_STATE_CHARS) state = state.slice(0, MAX_STATE_CHARS);
  return { model, state, questions: buildQuestions(candidates) };
}

const cut = (s: string | null | undefined, n: number) => (s ?? "").slice(0, n);
const paths = (xs: string[], n: number) => xs.slice(0, n).map(safePath);

function buildState(repo: string, candidates: Candidate[], recent: MainMove[], settings: AdviseConfig, files: number): string {
  return JSON.stringify(
    {
      repository: repo,
      open_pull_requests: candidates.map((c) => ({
        id: prId(c.number),
        title: cut(c.branch.pr_title, 200),
        branch: cut(c.branch.name, 200),
        issue: issueFromBranch(c.branch.name, settings)?.ref ?? null,
        draft: c.branch.pr_draft,
        ci: c.branch.ci,
        files_changed: paths(c.branch.files, files),
        files_changed_total: c.branch.files.length,
        commit_messages: c.branch.commits.slice(-20).map((m) => cut(m, 200)),
        commits_ahead: c.branch.ahead,
        commits_behind_default_branch: c.branch.behind,
        age_minutes: c.ageMinutes,
        sensitive_paths: paths(c.branch.sensitive, 20),
        files_the_default_branch_changed_since_its_base: paths(c.stale, 20),
        base_older_than_the_record_of_the_default_branch: c.baseUnknown,
        overlap_with_other_open_pull_requests: c.overlaps.map((o) => ({ with: prId(o.with), cosine: o.cosine, paths: o.paths, shared_files: paths(o.shared, 20) })),
      })),
      recently_landed: recent.slice(0, 5).map((m) => ({ at: m.at, commits: m.commits.slice(0, 10).map((x) => cut(x, 200)), files: paths(m.files, 50) })),
    },
    null,
    1,
  );
}

function buildQuestions(candidates: Candidate[]): Record<string, ClefQuestion> {
  const questions: Record<string, ClefQuestion> = {};
  // A choice needs at least two options; with one candidate the order is settled.
  if (candidates.length > 1) {
    questions.next = {
      type: "choice",
      instructions:
        "Which open pull request should land on the default branch next? Prefer green CI, the smallest blast radius, the least overlap with the other open pull requests, no rebase needed, and the oldest on ties.",
      criteria: Object.fromEntries(candidates.map((c) => [prId(c.number), summarize(c)])),
    };
  }
  for (const c of candidates) {
    const id = prId(c.number);
    questions[`unattended.${id}`] = {
      type: "noul",
      instructions: `May pull request ${id} land on the default branch with no human review? Yes only if its CI passed on its head, it touches no file another open pull request touches, it changes no dependency manifest, infrastructure or sensitive file, and its commit messages explain the change.`,
    };
    questions[`risk.${id}`] = {
      type: "score",
      instructions: `How much risk does landing ${id} pose to the other changes in flight?`,
      criteria: RISK_LEVELS,
    };
  }
  return questions;
}

/** Without Clef, or for the candidates it left out: green CI first, then least overlap, then oldest. */
function fallbackRank(a: Candidate, b: Candidate): number {
  const ci = (c: Candidate) => (c.branch.ci === "pass" ? 0 : c.branch.ci === "fail" ? 2 : 1);
  const shared = (c: Candidate) => c.overlaps.reduce((n, o) => n + o.shared.length, 0) + c.stale.length + (c.baseUnknown ? 1 : 0);
  return ci(a) - ci(b) || shared(a) - shared(b) || b.ageMinutes - a.ageMinutes || a.number - b.number;
}

export interface Verdict {
  number: number;
  position: number;
  nextP: number | null;
  unattended: number | null;
  risk: number | null;
  eligible: boolean;
  reasons: string[];
  label: string | null;
}

const finite = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Clef's answers and the house rules, as one verdict per candidate in landing order. */
export function decide(candidates: Candidate[], raw: unknown, thresholds: LockkeeperConfig["clef"]): Verdict[] {
  const ids = candidates.map((c) => prId(c.number));
  const d = raw == null ? null : parseMergeDecision(raw, ids);
  const p = (c: Candidate) => finite(d?.nextProbabilities[prId(c.number)]);
  const ordered = [...candidates].sort((a, b) => {
    // Clef's pick leads, then its probabilities; what it did not rank falls back to the rules.
    const pick = (c: Candidate) => (d?.next === prId(c.number) ? 0 : 1);
    return pick(a) - pick(b) || (p(b) ?? -1) - (p(a) ?? -1) || fallbackRank(a, b);
  });
  return ordered.map((c, i) => {
    const b = c.branch;
    const unattended = finite(d?.unattended[prId(c.number)]);
    const risk = finite(d?.risk[prId(c.number)]);
    const reasons: string[] = [];
    if (b.sensitive.length) reasons.push(`touches sensitive paths (${tick(b.sensitive)})`);
    if (b.ci === "fail") reasons.push("CI failed on its head");
    else if (b.ci === "pending") reasons.push("CI has not reported on its head yet");
    else if (b.ci === "none") reasons.push("no CI result on its head");
    const sharing = c.overlaps.filter((o) => o.shared.length);
    if (sharing.length) reasons.push(`shares files with ${sharing.map((o) => `#${o.with}`).join(", ")} (${tick([...new Set(sharing.flatMap((o) => o.shared))])})`);
    if (c.stale.length) reasons.push(`the default branch changed ${tick(c.stale)} since its base: rebase first`);
    else if (c.baseUnknown) reasons.push(`it is ${b.behind} commits behind the default branch, from a base older than the record of what changed: rebase first`);
    if (unattended === null || risk === null) reasons.push("Clef gave no answer");
    else {
      if (unattended < thresholds.unattended) reasons.push(`Clef's unattended ${unattended.toFixed(2)} is under ${thresholds.unattended.toFixed(2)}`);
      if (risk > thresholds.maxRisk) reasons.push(`Clef's risk ${risk.toFixed(2)} is over ${thresholds.maxRisk.toFixed(2)}`);
    }
    return {
      number: c.number,
      position: i + 1,
      nextP: candidates.length > 1 ? p(c) : null,
      unattended,
      risk,
      eligible: reasons.length === 0,
      reasons,
      label: b.sensitive.length ? "security" : null,
    };
  });
}

function riskWord(risk: number): string {
  return RISK_LEVELS[Math.min(RISK_LEVELS.length - 1, Math.max(0, Math.round(risk)))].toLowerCase();
}

/** The comment: the head it speaks for, the order, the verdict with its evidence. No timestamps, so an unchanged verdict is never rewritten. */
export function commentBody(c: Candidate, v: Verdict, all: Verdict[], settings: AdviseConfig): string {
  const before = all.filter((x) => x.position < v.position).map((x) => `#${x.number}`);
  const issue = issueFromBranch(c.branch.name, settings);
  const lines = [
    MARKER,
    `### Lockkeeper advice · \`${c.branch.head_sha.slice(0, 7)}\``,
    "",
    all.length === 1
      ? "**Landing order:** the only open pull request in this repository."
      : `**Landing order:** ${v.position} of ${all.length} open pull requests in this repository${before.length ? ` (after ${before.join(", ")})` : " (first)"}.`,
    v.eligible ? "**Unattended-eligible:** yes. CI passed on this head, no other open pull request shares its files, and nothing in it is sensitive." : `**Unattended-eligible:** no. ${v.reasons.map((r) => r[0].toUpperCase() + r.slice(1)).join(". ")}.`,
  ];
  if (v.risk !== null && v.unattended !== null) {
    lines.push(
      `**Risk to the other changes in flight:** ${riskWord(v.risk)} (${v.risk.toFixed(2)} of 3). Clef: unattended ${v.unattended.toFixed(2)}${v.nextP !== null ? `, next ${v.nextP.toFixed(2)}` : ""}.`,
    );
  }
  if (v.label) lines.push(`**Suggested label:** \`${v.label}\`.`);
  if (issue) lines.push(`**Issue:** ${issue.ref}, bound by the branch name.`);
  lines.push("", "<sub>Advice only: Lockkeeper lands nothing and applies no label. It rewrites this comment when the head, CI or the other open pull requests change.</sub>");
  return lines.join("\n");
}

async function fingerprint(head: string | null, open: BranchRow[]): Promise<string> {
  return sha256(JSON.stringify([head, open.map((b) => [b.name, b.pr_number, b.head_sha, b.ci, b.pr_title])]));
}

function workersAiClef(env: Pick<AdviseEnv, "AI">): Clef | null {
  if (!env.AI) return null;
  return (request) => env.AI!.run((request.model === "clef-flash" ? "@cf/cloudflare/clef-flash" : "@cf/cloudflare/clef") as never, request as never);
}

export async function advise(env: AdviseEnv, opts: AdviseOptions = {}): Promise<AdviseReport> {
  const settings = opts.settings ?? config.advise;
  const thresholds = opts.thresholds ?? config.clef;
  const now = opts.now ?? (() => new Date());
  const clef = opts.clef === undefined ? workersAiClef(env) : opts.clef;
  const report: AdviseReport = { repos: 0, asked: 0, candidates: 0, comments: 0, outcomes: 0, errors: [] };
  if (!(await takeLease(env, LEASE, now().getTime(), 4 * 60_000))) return { ...report, skipped: "another advising pass is running" };
  const gh = new GitHub({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, owner: settings.owner }, opts.fetcher);
  try {
    for (const repo of await getRepos(env)) {
      try {
        await adviseRepo(env, gh, repo.repo, repo.head_sha, clef, settings, thresholds, now(), Boolean(opts.force), report);
        report.repos++;
      } catch (err) {
        report.errors.push(`${repo.repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (settings.advice.comment) await syncComments(env, gh, settings, now(), report);
    await pruneDecisions(env, new Date(now().getTime() - 90 * 24 * 3600_000).toISOString());
    await setSetting(env, "advise_report", JSON.stringify({ ...report, at: now().toISOString() }));
  } finally {
    await dropLease(env, LEASE);
  }
  return report;
}

async function adviseRepo(
  env: AdviseEnv,
  gh: GitHub,
  repo: string,
  head: string | null,
  clef: Clef | null,
  settings: AdviseConfig,
  thresholds: LockkeeperConfig["clef"],
  now: Date,
  force: boolean,
  report: AdviseReport,
): Promise<void> {
  const nowIso = now.toISOString();
  const open = openPulls(await getBranches(env, repo), thresholds.maxCandidates);
  report.candidates += open.length;
  const fp = await fingerprint(head, open);
  const key = `advice_fp:${repo}`;
  const retryKey = `advice_retry:${repo}`;
  if (!force) {
    if ((await getSetting(env, key)) === fp) return;
    // Clef failed or answered in part a moment ago: the order from the rules stands until the retry.
    const retry = await getSetting(env, retryKey);
    if (retry && retry.startsWith(`${fp}:`) && Number(retry.slice(fp.length + 1)) > now.getTime()) return;
  }
  const recent = await recentMainMoves(env, repo, new Date(now.getTime() - 14 * 24 * 3600_000).toISOString());
  const candidates = await candidatesOf(env, open, recent, now);

  const previous = await getAdvice(env, repo);
  // Calibration: a candidate that left is recorded with what the advice said and what became of it.
  // Read first, written after the new advice is in place, so a failure below never counts one twice.
  const outcomes: Outcome[] = [];
  for (const old of previous) {
    if (candidates.some((c) => c.branch.name === old.branch && c.number === old.pr_number)) continue;
    let outcome: Outcome["outcome"] = "unknown";
    try {
      const pr = await gh.pull(repo, old.pr_number);
      if (pr.state === "open") continue; // still open, only out of this round (over the cap)
      outcome = pr.merged ? "landed" : "closed";
    } catch (err) {
      // Gone from GitHub: unknown. Anything else is transient: stop here, the next pass reads it again.
      if (!(err instanceof GitHubError && err.status === 404)) throw err;
    }
    outcomes.push({
      repo,
      pr_number: old.pr_number,
      head_sha: old.head_sha,
      position: old.position,
      candidates: previous.length,
      unattended: old.unattended,
      risk: old.risk,
      eligible: old.eligible,
      outcome,
      at: nowIso,
    });
  }
  const recordOutcomes = async () => {
    for (const o of outcomes) await addOutcome(env, o);
    report.outcomes += outcomes.length;
  };

  if (candidates.length === 0) {
    await replaceAdvice(env, repo, []);
    await recordOutcomes();
    await setSetting(env, key, fp);
    return;
  }

  const decisionId = `d-${crypto.randomUUID().slice(0, 12)}`;
  const request = buildAdviceRequest(repo, candidates, recent, config.clef.model, settings);
  let raw: unknown = null;
  let error: string | null = clef ? null : "Clef is not bound";
  if (clef) {
    try {
      raw = await clef(request);
      report.asked++;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      report.errors.push(`${repo}: Clef failed: ${error}`);
    }
  }
  // The ledger is a record, not a gate: advice is still written when a row cannot be.
  await addDecision(env, { id: decisionId, repo, candidates: candidates.map((c) => prId(c.number)), request, response: raw, error, at: nowIso }).catch((err) =>
    report.errors.push(`${repo}: decision not recorded: ${err instanceof Error ? err.message : String(err)}`),
  );

  const verdicts = decide(candidates, raw, thresholds);
  const rows: AdviceRow[] = verdicts.map((v) => {
    const c = candidates.find((x) => x.number === v.number) as Candidate;
    const old = previous.find((p) => p.branch === c.branch.name && p.pr_number === c.number);
    return {
      repo,
      branch: c.branch.name,
      pr_number: c.number,
      head_sha: c.branch.head_sha,
      position: v.position,
      next_p: v.nextP,
      unattended: v.unattended,
      risk: v.risk,
      eligible: v.eligible,
      reasons: v.reasons,
      label: v.label,
      issue: issueFromBranch(c.branch.name, settings)?.ref ?? null,
      body: commentBody(c, v, verdicts, settings),
      comment_id: old?.comment_id ?? null,
      comment_hash: old?.comment_hash ?? null,
      decision_id: decisionId,
      decided_at: nowIso,
    };
  });
  await replaceAdvice(env, repo, rows);
  await recordOutcomes();
  // Answered in full (or no Clef bound): wait for the candidates to move. Failed or answered in
  // part: ask again, but not before `RETRY_MS`, so a model that stays down costs two requests an hour.
  const answered = verdicts.every((v) => v.unattended !== null && v.risk !== null);
  if (!clef || answered) await setSetting(env, key, fp);
  else {
    if (raw != null) report.errors.push(`${repo}: Clef answered in part`);
    await setSetting(env, retryKey, `${fp}:${now.getTime() + RETRY_MS}`);
  }
}

/** Writes each comment whose text changed. A refusal (the App lacks the permission) pauses comments for `retryHours`. */
async function syncComments(env: AdviseEnv, gh: GitHub, settings: AdviseConfig, now: Date, report: AdviseReport): Promise<void> {
  const blocked = await getSetting(env, BLOCKED);
  if (blocked && Date.parse(blocked) > now.getTime()) return;
  let writes = 0;
  for (const row of await getAdvice(env)) {
    if (writes >= MAX_WRITES) break;
    const hash = await sha256(row.body);
    if (row.comment_hash === hash) continue;
    try {
      let id = row.comment_id;
      if (id === null) {
        // A comment from an earlier run whose id was lost (the table is rebuildable): take it over.
        const mine = (await gh.comments(row.repo, row.pr_number, 5)).find((c) => c.user?.type === "Bot" && c.body.startsWith(MARKER) && typeof c.id === "number");
        id = mine?.id ?? null;
      }
      let written: number;
      try {
        written = await gh.writeComment(row.repo, row.pr_number, id, row.body);
      } catch (err) {
        // The comment was deleted on GitHub: write it anew.
        if (!(id !== null && err instanceof GitHubError && err.status === 404)) throw err;
        written = await gh.writeComment(row.repo, row.pr_number, null, row.body);
      }
      await setAdviceComment(env, row.repo, row.branch, written, hash);
      writes++;
      report.comments++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`${row.repo}#${row.pr_number}: comment not written: ${msg}`);
      if (err instanceof GitHubError && (err.status === 403 || err.status === 401)) {
        await setSetting(env, BLOCKED, new Date(now.getTime() + settings.advice.retryHours * 3600_000).toISOString());
        return;
      }
    }
  }
}

// ---------- the answer, for the API, MCP and the OS gatekeeper of step 4 ----------

export interface LandingEntry {
  position: number;
  pr: number;
  title: string | null;
  url: string | null;
  branch: string;
  head: string;
  draft: boolean;
  ci: string;
  ahead: number;
  behind: number;
  eligible: boolean;
  reasons: string[];
  unattended: number | null;
  risk: number | null;
  nextP: number | null;
  label: string | null;
  issue: string | null;
  decidedAt: string;
}

export interface LandingOrder {
  repo: string;
  defaultBranch: string;
  head: string | null;
  order: LandingEntry[];
}

export async function landingOrder(env: AdviseEnv, repo?: string): Promise<LandingOrder[]> {
  const out: LandingOrder[] = [];
  for (const r of (await getRepos(env)).filter((x) => !repo || x.repo === repo)) {
    const rows = await getAdvice(env, r.repo);
    if (!rows.length && !repo) continue;
    const branches = new Map((await getBranches(env, r.repo)).map((b) => [b.name, b]));
    out.push({
      repo: r.repo,
      defaultBranch: r.default_branch,
      head: r.head_sha,
      order: rows.map((a) => {
        const b = branches.get(a.branch);
        return {
          position: a.position,
          pr: a.pr_number,
          title: b?.pr_title ?? null,
          url: b?.pr_url ?? null,
          branch: a.branch,
          head: a.head_sha,
          draft: b?.pr_draft ?? false,
          ci: b?.ci ?? "none",
          ahead: b?.ahead ?? 0,
          behind: b?.behind ?? 0,
          eligible: a.eligible,
          reasons: a.reasons,
          unattended: a.unattended,
          risk: a.risk,
          nextP: a.next_p,
          label: a.label,
          issue: a.issue,
          decidedAt: a.decided_at,
        };
      }),
    });
  }
  return out;
}

export function landingText(orders: LandingOrder[]): string {
  const lines: string[] = [];
  for (const o of orders) {
    lines.push(`${o.repo}${o.head ? ` (${o.defaultBranch} at ${o.head.slice(0, 7)})` : ""}:`);
    if (!o.order.length) lines.push("- no open pull request");
    for (const e of o.order) {
      const facts = [`CI ${e.ci}`, e.eligible ? "unattended-eligible" : `not unattended-eligible: ${e.reasons.join("; ")}`];
      if (e.risk !== null) facts.push(`risk ${e.risk.toFixed(2)} of 3`);
      if (e.label) facts.push(`suggest \`${e.label}\``);
      if (e.issue) facts.push(`issue ${e.issue}`);
      lines.push(`${e.position}. #${e.pr}${e.draft ? " (draft)" : ""} "${e.title ?? e.branch}" on \`${e.branch}\`: ${facts.join(", ")}`);
    }
  }
  if (!lines.length) return "No open pull request in any repository.";
  lines.push("Advice, not a lock: Lockkeeper lands nothing; a person does.");
  return lines.join("\n");
}
