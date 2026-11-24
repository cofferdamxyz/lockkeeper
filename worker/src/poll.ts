import config, { type LockkeeperConfig } from "../../lockkeeper.config";
import type { LockkeeperEnv } from "./env";
import { CiReader } from "./ci";
import { changedPaths, GitHub, GitHubError, type CompareInfo, type Fetch, type PullInfo } from "./github";
import { sensitiveHits } from "./paths";
import {
  addMainMove,
  deleteBranch,
  deleteRepo,
  dropLease,
  getBranches,
  getRepo,
  getRepos,
  getSetting,
  pruneClaims,
  pruneMainMoves,
  putBranch,
  putRepo,
  releaseClaimsForBranch,
  setSetting,
  takeLease,
  type BranchRow,
} from "./store";
import { branchText, branchVectorId, remove, upsert } from "./vectorIndex";

/**
 * The poller (DESIGN.md, "The poller and the index"): every few minutes it reads GitHub through the App, with no
 * public ingress and no webhook secret. Per repository: the branch list, the open pull requests
 * and the state of CI on each head (ci.ts); a compare for every branch whose head moved, and one
 * for the default branch when it moved. It writes only Lockkeeper's own D1 and index, never GitHub.
 */

export interface PollReport {
  repos: number;
  branchesChanged: number;
  branchesRemoved: number;
  mainMoves: number;
  calls: number;
  errors: string[];
  /** What a reader of the report should know that is not a failure: check runs refused and paused. */
  notes?: string[];
  skipped?: string;
}

const LEASE = "poll_lease";
/** Until when check runs are not asked for, after GitHub refused them (the App lacks Checks read). */
export const CHECKS_BLOCKED = "ci_checks_blocked_until";

export function firstLine(message: string): string {
  return message.split("\n", 1)[0].slice(0, 200);
}

export async function poll(
  env: LockkeeperEnv,
  opts: { fetcher?: Fetch; now?: () => Date; settings?: LockkeeperConfig; /** Ask for check runs even while they are paused (a poll someone asked for). */ retryChecks?: boolean } = {},
): Promise<PollReport> {
  const settings = opts.settings ?? config;
  const now = opts.now ?? (() => new Date());
  const report: PollReport = { repos: 0, branchesChanged: 0, branchesRemoved: 0, mainMoves: 0, calls: 0, errors: [] };
  if (!(await takeLease(env, LEASE, now().getTime(), 4 * 60_000))) return { ...report, skipped: "another poll is running" };
  const gh = new GitHub({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, owner: settings.owner }, opts.fetcher);
  const blockedUntil = settings.ci.sources.includes("checks") ? await getSetting(env, CHECKS_BLOCKED) : null;
  const paused = !opts.retryChecks && Boolean(blockedUntil) && blockedUntil! > now().toISOString();
  const ci = new CiReader(gh, settings.ci, !paused);
  try {
    const visible = (await gh.repositories()).filter((r) => !r.archived && !settings.exclude.includes(r.name));
    const names = new Set(visible.map((r) => r.full_name));
    for (const known of await getRepos(env)) if (!names.has(known.repo)) await deleteRepo(env, known.repo);
    for (const repo of visible) {
      try {
        await pollRepo(env, gh, ci, repo.full_name, repo.default_branch, repo.pushed_at, settings, now, report);
        report.repos++;
      } catch (err) {
        report.errors.push(`${repo.full_name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const nowIso = now().toISOString();
    // A refusal is never read as "no CI": it is reported, and check runs wait for `ci.retryHours`.
    // The pause stands until GitHub answers, whether or not this pass asked: a poll someone asked
    // for that found no pull request to ask about must not read as "granted".
    let until = blockedUntil || null;
    if (ci.refused) {
      until = new Date(now().getTime() + settings.ci.retryHours * 3600_000).toISOString();
      await setSetting(env, CHECKS_BLOCKED, until);
    } else if (ci.answered) {
      until = null;
      if (blockedUntil) await setSetting(env, CHECKS_BLOCKED, ""); // GitHub answers again: the pause is over
    }
    if (until) {
      const rest = settings.ci.sources.filter((s) => s !== "checks");
      const when = until > nowIso ? `not asked again until ${until}` : "asked again at the next poll";
      report.notes = [
        `GitHub refused check runs (the App needs Checks read); ${when}. ${rest.length ? `CI is read from: ${rest.join(", ")}.` : "No other CI source is configured, so CI reads as unknown."}`,
      ];
    }
    await pruneClaims(env, new Date(now().getTime() - 24 * 3600_000).toISOString());
    await pruneMainMoves(env, new Date(now().getTime() - 14 * 24 * 3600_000).toISOString());
    await setSetting(env, "polled_at", nowIso);
    await setSetting(env, "poll_report", JSON.stringify({ ...report, calls: gh.calls, at: nowIso }));
  } finally {
    report.calls = gh.calls;
    await dropLease(env, LEASE);
  }
  return report;
}

async function pollRepo(
  env: LockkeeperEnv,
  gh: GitHub,
  ciReader: CiReader,
  repo: string,
  defaultBranch: string,
  pushedAt: string | null,
  settings: LockkeeperConfig,
  now: () => Date,
  report: PollReport,
): Promise<void> {
  const nowIso = now().toISOString();
  const prev = await getRepo(env, repo);
  const known = new Map((await getBranches(env, repo)).map((b) => [b.name, b]));
  const pulls = await gh.pulls(repo);
  const prByBranch = new Map<string, PullInfo>();
  for (const p of pulls) if (p.head.repo?.full_name === repo) prByBranch.set(p.head.ref, p);

  // Nothing pushed since the last poll: refresh only what pull requests and CI say.
  const quiet = prev && prev.pushed_at === pushedAt && prev.default_branch === defaultBranch && prev.head_sha;
  let head = prev?.head_sha ?? null;
  if (!quiet) {
    const branches = await gh.branches(repo);
    const main = branches.find((b) => b.name === defaultBranch);
    head = main?.commit.sha ?? head;
    if (prev?.head_sha && head && prev.head_sha !== head) {
      const moved = await gh.compare(repo, prev.head_sha, head);
      await addMainMove(env, {
        repo,
        before_sha: prev.head_sha,
        after_sha: head,
        files: changedPaths(moved),
        commits: moved.commits.map((c) => `${c.sha.slice(0, 7)} ${firstLine(c.commit.message)}`),
        at: nowIso,
      });
      report.mainMoves++;
    }
    const seen = new Set<string>();
    for (const b of branches) {
      if (b.name === defaultBranch) continue;
      seen.add(b.name);
      const old = known.get(b.name);
      const pr = prByBranch.get(b.name) ?? null;
      if (old && old.head_sha === b.commit.sha && old.base_sha && head === prev?.head_sha) {
        continue; // unchanged; PR fields refresh below
      }
      let cmp: CompareInfo;
      try {
        cmp = await gh.compare(repo, defaultBranch, b.name);
      } catch (err) {
        // A branch with no common ancestor (an orphan release branch, say) is not work in flight
        // on the default branch: GitHub answers 404 "No common ancestor". Skip it quietly.
        if (err instanceof GitHubError && err.status === 404) {
          if (old) {
            await deleteBranch(env, repo, b.name);
            await remove(env, [await branchVectorId(repo, b.name)]);
            known.delete(b.name);
            report.branchesRemoved++;
          }
          continue;
        }
        throw err;
      }
      if (cmp.ahead_by === 0 && !pr) {
        if (old) {
          await deleteBranch(env, repo, b.name);
          await remove(env, [await branchVectorId(repo, b.name)]);
          known.delete(b.name); // or the loop over pull requests below would write the row back
          report.branchesRemoved++;
        }
        continue; // nothing in flight on it (merged, or never moved)
      }
      const files = changedPaths(cmp);
      const last = cmp.commits[cmp.commits.length - 1];
      const row: BranchRow = {
        repo,
        name: b.name,
        head_sha: b.commit.sha,
        base_sha: cmp.merge_base_commit.sha,
        ahead: cmp.ahead_by,
        behind: cmp.behind_by,
        files,
        commits: cmp.commits.map((c) => firstLine(c.commit.message)),
        author: last?.author?.login ?? last?.commit.author?.name ?? old?.author ?? null,
        last_commit_at: last?.commit.author?.date ?? old?.last_commit_at ?? null,
        pr_number: pr?.number ?? null,
        pr_title: pr?.title ?? null,
        pr_url: pr?.html_url ?? null,
        pr_draft: pr?.draft ?? false,
        // CI is evidence about one head: a state read on another head is never carried over, even
        // if the read below fails and leaves this row as it is.
        ci: old && old.head_sha === b.commit.sha ? old.ci : "none",
        sensitive: sensitiveHits(repo, files, settings.sensitive),
        updated_at: nowIso,
      };
      await putBranch(env, row);
      known.set(b.name, row);
      report.branchesChanged++;
      if (!old || old.head_sha !== row.head_sha) {
        await releaseClaimsForBranch(env, repo, b.name, nowIso);
        await upsert(env, [{ id: await branchVectorId(repo, b.name), text: branchText(row), meta: { kind: "branch", repo, name: b.name } }]);
      }
    }
    for (const [name] of known) {
      if (!seen.has(name)) {
        await deleteBranch(env, repo, name);
        await remove(env, [await branchVectorId(repo, name)]);
        known.delete(name);
        report.branchesRemoved++;
      }
    }
  }

  // Pull request fields and CI for every branch with an open pull request.
  for (const [name, row] of known) {
    const pr = prByBranch.get(name) ?? null;
    // On a quiet poll the branch scan is skipped, so a push that landed since can leave the row a
    // head behind the pull request: nothing is read for a commit that is no longer the head.
    const ci = pr && pr.head.sha === row.head_sha ? await ciReader.state(repo, pr.number, row.head_sha) : "none";
    const changed =
      row.pr_number !== (pr?.number ?? null) || row.pr_title !== (pr?.title ?? null) || row.pr_draft !== (pr?.draft ?? false) || row.ci !== ci;
    if (!changed) continue;
    await putBranch(env, { ...row, pr_number: pr?.number ?? null, pr_title: pr?.title ?? null, pr_url: pr?.html_url ?? null, pr_draft: pr?.draft ?? false, ci, updated_at: nowIso });
  }

  await putRepo(env, { repo, default_branch: defaultBranch, head_sha: head, pushed_at: pushedAt, polled_at: nowIso });
}
