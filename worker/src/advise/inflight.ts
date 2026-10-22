import config, { type AdviseConfig } from "../../../lockkeeper.config";
import { jaccard } from "../vectors";
import type { AdviseEnv } from "./env";
import { GitHub, type Fetch } from "./github";
import { firstLine } from "./poll";
import { sensitiveHits, sharedPaths } from "./paths";
import { activeClaims, getBranches, getRepo, getSetting, recentMainMoves, type BranchRow, type ClaimRow, type MainMove } from "./store";
import { branchVectorId, claimVectorId, similarity } from "./vectorIndex";

/**
 * What is in flight near a set of paths (DESIGN.md §12): branches ahead of the default branch,
 * open pull requests and live claims, each with the paths it shares, the Jaccard of the path sets
 * and, when the index is bound, the cosine of the query text against it. Awareness only: nothing
 * here blocks, holds or orders anything.
 */

export interface Query {
  repo: string;
  paths: string[];
  /** The goal, the branch's commit messages: anything that says what the work is. */
  text?: string;
  /** The asker's own branch and claim, left out of the answer. */
  branch?: string;
  claim?: string;
}

export interface Near {
  kind: "branch" | "claim";
  id: string;
  label: string;
  shared: string[];
  jaccard: number;
  cosine: number | null;
  branch?: BranchRow;
  claim?: ClaimRow;
}

export interface InFlight {
  repo: string;
  defaultBranch: string | null;
  head: string | null;
  polledAt: string | null;
  near: Near[];
  others: number;
  recent: MainMove[];
  sensitive: string[];
}

function stale(b: BranchRow, nowMs: number, settings: AdviseConfig): boolean {
  if (b.pr_number) return false;
  if (!b.last_commit_at) return false;
  return nowMs - Date.parse(b.last_commit_at) > settings.staleDays * 24 * 3600_000;
}

export async function inFlight(
  env: AdviseEnv,
  q: Query,
  opts: { now?: Date; settings?: AdviseConfig } = {},
): Promise<InFlight> {
  const settings = opts.settings ?? config.advise;
  const now = opts.now ?? new Date();
  const repoRow = await getRepo(env, q.repo);
  const branches = (await getBranches(env, q.repo)).filter((b) => b.name !== q.branch && !stale(b, now.getTime(), settings));
  const claims = (await activeClaims(env, now.toISOString(), q.repo)).filter((c) => c.id !== q.claim && !(q.branch && c.branch === q.branch));
  const cos = q.text ? await similarity(env, q.repo, q.text).catch(() => new Map<string, number>()) : new Map<string, number>();
  const everything = q.paths.length === 0 && !q.text;

  const near: Near[] = [];
  for (const b of branches) {
    const shared = sharedPaths(q.paths, b.files);
    const cosine = cos.get(await branchVectorId(b.repo, b.name)) ?? null;
    if (everything || shared.length || (cosine ?? 0) >= settings.nearCosine) {
      near.push({ kind: "branch", id: b.name, label: b.pr_number ? `#${b.pr_number} ${b.pr_title ?? b.name}` : b.name, shared, jaccard: jaccard(q.paths, b.files), cosine, branch: b });
    }
  }
  for (const c of claims) {
    // A claim with no paths claims the repository: it is near everything there.
    const shared = c.paths.length ? sharedPaths(q.paths, c.paths) : q.paths;
    const cosine = cos.get(claimVectorId(c.id)) ?? null;
    if (everything || shared.length || c.paths.length === 0 || (cosine ?? 0) >= settings.nearCosine) {
      near.push({ kind: "claim", id: c.id, label: c.goal, shared, jaccard: jaccard(q.paths, c.paths), cosine, claim: c });
    }
  }
  near.sort((a, b) => b.shared.length - a.shared.length || (b.cosine ?? 0) - (a.cosine ?? 0) || b.jaccard - a.jaccard);

  const since = new Date(now.getTime() - settings.recentHours * 3600_000).toISOString();
  return {
    repo: q.repo,
    defaultBranch: repoRow?.default_branch ?? null,
    head: repoRow?.head_sha ?? null,
    polledAt: repoRow?.polled_at ?? (await getSetting(env, "polled_at")),
    near,
    others: branches.length + claims.length - near.length,
    recent: await recentMainMoves(env, q.repo, since),
    sensitive: sensitiveHits(q.repo, q.paths, settings.sensitive),
  };
}

// ---------- the pre-commit and pre-push check ----------

export interface CheckInput extends Query {
  /** The commit the work started from (`git merge-base HEAD origin/<default>`). */
  base: string;
}

export interface Check {
  defaultBranch: string;
  head: string;
  behind: number;
  /** Commits on the default branch since `base`, first lines. */
  moved: string[];
  /** Files changed on the default branch since `base` that the asker also changed. */
  collisions: string[];
  movedFiles: number;
  inflight: InFlight;
}

/** Reads GitHub live (one compare), because the base is the asker's and the poll may lag. */
export async function check(env: AdviseEnv, q: CheckInput, opts: { fetcher?: Fetch; now?: Date; settings?: AdviseConfig } = {}): Promise<Check> {
  const settings = opts.settings ?? config.advise;
  const flight = await inFlight(env, q, opts);
  const defaultBranch = flight.defaultBranch ?? "main";
  const gh = new GitHub({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, owner: settings.owner }, opts.fetcher);
  const cmp = await gh.compare(q.repo, q.base, defaultBranch);
  const files = (cmp.files ?? []).map((f) => f.filename);
  const head = cmp.commits.length ? cmp.commits[cmp.commits.length - 1].sha : q.base;
  return {
    defaultBranch,
    head,
    behind: cmp.ahead_by,
    moved: cmp.commits.map((c) => `${c.sha.slice(0, 7)} ${firstLine(c.commit.message)}`),
    collisions: sharedPaths(q.paths, files),
    movedFiles: files.length,
    inflight: flight,
  };
}

// ---------- text, for hooks and MCP ----------

function ago(iso: string | null, now: Date): string {
  if (!iso) return "unknown";
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

function until(iso: string, now: Date): string {
  const m = Math.max(0, Math.round((Date.parse(iso) - now.getTime()) / 60_000));
  return m < 120 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
}

function list(xs: string[], max = 6): string {
  const shown = xs.slice(0, max).map((x) => `\`${x}\``).join(", ");
  return xs.length > max ? `${shown} and ${xs.length - max} more` : shown;
}

function nearLine(n: Near, now: Date): string {
  const facts: string[] = [];
  if (n.kind === "branch" && n.branch) {
    const b = n.branch;
    facts.push(b.pr_number ? `PR #${b.pr_number}${b.pr_draft ? " (draft)" : ""} "${b.pr_title ?? ""}"` : "no pull request");
    if (b.ci !== "none") facts.push(`CI ${b.ci}`);
    facts.push(`${b.ahead} ahead, ${b.behind} behind`, `last commit ${ago(b.last_commit_at, now)}${b.author ? ` by ${b.author}` : ""}`);
    if (b.sensitive.length) facts.push("touches sensitive paths");
  } else if (n.claim) {
    const c = n.claim;
    facts.push(`claimed by ${c.session ? `${c.session} (${c.who})` : c.who}`, `expires ${until(c.expires_at, now)}`);
    if (c.paths.length) facts.push(`on ${list(c.paths, 4)}`);
    else facts.push("on the whole repository");
  }
  const shared = n.shared.length ? `; shares ${list(n.shared)}` : "";
  const cos = n.cosine !== null ? `; similarity ${n.cosine.toFixed(2)}` : "";
  const name = n.kind === "branch" ? `branch \`${n.id}\`` : `claim "${n.label.slice(0, 120)}"`;
  return `- ${name}: ${facts.join(", ")}${shared}${cos}`;
}

const PRINCIPLE = "Awareness, not a lock: main always wins and branches rebase onto it; nothing here stops you.";

export function briefText(f: InFlight, now = new Date()): string {
  const lines = [
    `Lockkeeper: ${f.repo}${f.head ? ` (${f.defaultBranch} at ${f.head.slice(0, 7)}, read ${ago(f.polledAt, now)})` : " (not polled yet)"}`,
  ];
  if (f.near.length) {
    lines.push("In flight near your work:", ...f.near.slice(0, 12).map((n) => nearLine(n, now)));
    if (f.near.length > 12) lines.push(`- and ${f.near.length - 12} more`);
  } else {
    lines.push("Nothing in flight near your work.");
  }
  if (f.others > 0) lines.push(`${f.others} other change${f.others === 1 ? "" : "s"} in flight elsewhere in the repository.`);
  if (f.recent.length) {
    const commits = f.recent.flatMap((m) => m.commits).slice(0, 8);
    const files = [...new Set(f.recent.flatMap((m) => m.files))];
    lines.push(`Landed on ${f.defaultBranch ?? "main"} recently (${files.length} files):`, ...commits.map((c) => `- ${c}`));
  }
  if (f.sensitive.length) lines.push(`Sensitive paths in your set (never unattended-eligible; suggest the \`security\` label): ${list(f.sensitive)}.`);
  lines.push(PRINCIPLE);
  return lines.join("\n");
}

export function checkText(c: Check, now = new Date()): string {
  const lines: string[] = [];
  if (c.behind === 0) lines.push(`Lockkeeper: ${c.defaultBranch} has not moved since your base.`);
  else {
    lines.push(`Lockkeeper: ${c.defaultBranch} moved ${c.behind} commit${c.behind === 1 ? "" : "s"} since your base (${c.movedFiles} files):`);
    lines.push(...c.moved.slice(-8).map((m) => `- ${m}`));
    if (c.collisions.length) lines.push(`It changed files you changed too: ${list(c.collisions, 10)}. Rebase onto origin/${c.defaultBranch} before you push.`);
    else lines.push(`None of them touch your files; rebasing onto origin/${c.defaultBranch} is still the house rule.`);
  }
  const near = c.inflight.near.filter((n) => n.shared.length);
  if (near.length) lines.push("Other work in flight on your files:", ...near.slice(0, 8).map((n) => nearLine(n, now)));
  if (c.inflight.sensitive.length) lines.push(`Sensitive paths in this change: ${list(c.inflight.sensitive)} (never unattended-eligible).`);
  lines.push(PRINCIPLE);
  return lines.join("\n");
}

export const toJson = (f: InFlight) => ({
  ...f,
  near: f.near.map(({ branch, claim, ...n }) => ({
    ...n,
    ...(branch ? { branch: { name: branch.name, head: branch.head_sha, ahead: branch.ahead, behind: branch.behind, files: branch.files, pr: branch.pr_number, prTitle: branch.pr_title, prUrl: branch.pr_url, draft: branch.pr_draft, ci: branch.ci, sensitive: branch.sensitive, lastCommitAt: branch.last_commit_at, author: branch.author } } : {}),
    ...(claim ? { claim: { id: claim.id, goal: claim.goal, paths: claim.paths, who: claim.who, session: claim.session, branch: claim.branch, expiresAt: claim.expires_at } } : {}),
  })),
});
