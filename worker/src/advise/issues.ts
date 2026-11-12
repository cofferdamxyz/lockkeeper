import type { AdviseConfig } from "../../../lockkeeper.config";

/**
 * A pull request is bound to its issue by its branch name, with no search: the dispatch routine
 * pushes `claude/<issue>-<slug>` and the issues live in one repository (`advise.issues`).
 */
export interface IssueRef {
  repo: string;
  number: number;
  /** `owner/repo#n`, as GitHub links it. */
  ref: string;
}

export function issueFromBranch(branch: string, settings: Pick<AdviseConfig, "owner" | "issues">): IssueRef | null {
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
