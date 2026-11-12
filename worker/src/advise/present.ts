import config, { type AdviseConfig } from "../../../lockkeeper.config";
import { landingOrder, safePath, type LandingEntry } from "./advice";
import type { AdviseEnv } from "./env";
import { issueFromBranch } from "./issues";
import { sharedPaths } from "./paths";
import { activeClaims, getBranches, getRepos, getSetting } from "./store";

/**
 * Everything the Development Tracker's Present column draws, in one read (DESIGN.md §13 step 4):
 * per repository the branches in flight with their pull request, CI, issue and overlap on each
 * other, the live claims, and the landing order of step 3. Read-only, and awareness only.
 */

export interface PresentBranch {
  name: string;
  head: string;
  ahead: number;
  behind: number;
  files: number;
  author: string | null;
  lastCommitAt: string | null;
  pr: { number: number; title: string | null; url: string | null; draft: boolean } | null;
  ci: string;
  sensitive: boolean;
  issue: string | null;
  /** Other branches in the repository that change a file this one changes. */
  overlaps: { with: string; shared: number; files: string[] }[];
}

export interface PresentClaim {
  id: string;
  goal: string;
  paths: string[];
  who: string;
  session: string | null;
  branch: string | null;
  expiresAt: string;
}

export interface PresentRepo {
  repo: string;
  defaultBranch: string;
  head: string | null;
  polledAt: string | null;
  branches: PresentBranch[];
  claims: PresentClaim[];
  order: LandingEntry[];
}

export interface Present {
  polledAt: string | null;
  advisedAt: string | null;
  repos: PresentRepo[];
}

export async function present(env: AdviseEnv, repo?: string, opts: { now?: Date; settings?: AdviseConfig } = {}): Promise<Present> {
  const settings = opts.settings ?? config.advise;
  const now = opts.now ?? new Date();
  const claims = await activeClaims(env, now.toISOString(), repo);
  const orders = new Map((await landingOrder(env, repo)).map((o) => [o.repo, o.order]));
  const repos: PresentRepo[] = [];
  for (const r of (await getRepos(env)).filter((x) => !repo || x.repo === repo)) {
    const all = await getBranches(env, r.repo);
    // The same rule as "in flight": a branch with no pull request and no commit for `staleDays` is not.
    const live = all.filter((b) => b.pr_number !== null || !b.last_commit_at || now.getTime() - Date.parse(b.last_commit_at) <= settings.staleDays * 24 * 3600_000);
    const mine = claims.filter((c) => c.repo === r.repo);
    if (!live.length && !mine.length && !repo) continue;
    repos.push({
      repo: r.repo,
      defaultBranch: r.default_branch,
      head: r.head_sha,
      polledAt: r.polled_at,
      branches: live.map((b) => ({
        name: b.name,
        head: b.head_sha,
        ahead: b.ahead,
        behind: b.behind,
        files: b.files.length,
        author: b.author,
        lastCommitAt: b.last_commit_at,
        pr: b.pr_number === null ? null : { number: b.pr_number, title: b.pr_title, url: b.pr_url, draft: b.pr_draft },
        ci: b.ci,
        sensitive: b.sensitive.length > 0,
        issue: issueFromBranch(b.name, settings)?.ref ?? null,
        overlaps: live
          .filter((o) => o.name !== b.name)
          .map((o) => ({ with: o.name, shared: sharedPaths(b.files, o.files) }))
          .filter((o) => o.shared.length)
          .map((o) => ({ with: o.with, shared: o.shared.length, files: o.shared.slice(0, 5).map(safePath) })),
      })),
      claims: mine.map((c) => ({ id: c.id, goal: c.goal, paths: c.paths.slice(0, 20), who: c.who, session: c.session, branch: c.branch, expiresAt: c.expires_at })),
      order: orders.get(r.repo) ?? [],
    });
  }
  const advised = await getSetting(env, "advise_report");
  let advisedAt: string | null = null;
  try {
    advisedAt = advised ? ((JSON.parse(advised) as { at?: string }).at ?? null) : null;
  } catch {
    advisedAt = null;
  }
  return { polledAt: await getSetting(env, "polled_at"), advisedAt, repos };
}
