import type { LockkeeperConfig } from "../../lockkeeper.config";

/**
 * A pull request is bound to its issue by its branch name, with no search: a pattern whose first
 * group is the issue's number, and the one repository the issues live in (`issues` in
 * `lockkeeper.config.ts`; null binds nothing).
 */
export interface IssueRef {
  repo: string;
  number: number;
  /** `owner/repo#n`, as GitHub links it. */
  ref: string;
}

export function issueFromBranch(branch: string, settings: Pick<LockkeeperConfig, "owner" | "issues">): IssueRef | null {
  if (!settings.issues) return null;
  let m: RegExpExecArray | null;
  try {
    m = new RegExp(settings.issues.branch).exec(branch);
  } catch {
    return null;
  }
  const n = m ? Number(m[1]) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) return null;
  const repo = `${settings.owner}/${settings.issues.repo}`;
  return { repo, number: n, ref: `${repo}#${n}` };
}
