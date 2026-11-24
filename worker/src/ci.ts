import type { LockkeeperConfig } from "./config";
import { ciFromCheckRuns, ciFromComments, GitHubError, type CiState, type GitHub } from "./github";

/**
 * The state of CI on a pull request's head, from every source the configuration names
 * (DESIGN.md, "The poller and the index"). Every source must agree for a head to be green: it is
 * `pass` only when each source asked says `pass`. One `fail` makes it `fail`, one `pending`
 * makes it `pending`, and a source with nothing to say about the head holds it at `none`, so a
 * success from one source never stands in for the silence of another.
 *
 * GitHub refuses check runs to an App without Checks read (403, "Resource not accessible by
 * integration"). That is not "no CI": the reader stops asking for the rest of the pass, sets
 * `refused` so the poller can report it and pause, and the head is judged by the other sources.
 */
export class CiReader {
  /** True once GitHub refused check runs during this pass. */
  refused = false;
  /** True once GitHub answered a request for check runs during this pass. */
  answered = false;

  constructor(
    private readonly gh: GitHub,
    private readonly settings: LockkeeperConfig["ci"],
    /** False while check runs are paused after an earlier refusal. */
    private checksOpen = true,
  ) {}

  async state(repo: string, pull: number, headSha: string): Promise<CiState> {
    const states: CiState[] = [];
    for (const source of this.settings.sources) {
      let state: CiState = "none";
      if (source === "checks") {
        if (!this.checksOpen) continue;
        try {
          const { runs, complete } = await this.gh.checkRuns(repo, headSha);
          this.answered = true;
          state = ciFromCheckRuns(runs, { ignore: this.settings.ignoreChecks, require: this.settings.requireChecks, complete });
        } catch (err) {
          // Only GitHub's own words for a missing permission, on the check-runs request itself, are
          // a refusal. Every other 403 (a rate limit, abuse detection, a suspended installation at
          // the token, whatever GitHub adds) fails this repository's poll like any other call:
          // pausing on one of those would drop what the check runs said.
          const refusal = err instanceof GitHubError && err.status === 403 && err.path.includes("/check-runs") && /not accessible by integration/i.test(err.message);
          if (!refusal) throw err;
          this.checksOpen = false;
          this.refused = true;
          continue;
        }
      } else if (source === "comment") {
        const { items, more } = await this.gh.commentPages(repo, pull);
        state = ciFromComments(items, headSha, this.settings.commentMarker);
        // A failed job's comment may be among those not read: a pull request with more comments than that is not green.
        if (more && state === "pass") state = "pending";
      }
      if (state === "fail") return "fail"; // nothing can be worse: the remaining sources are not asked
      states.push(state);
    }
    if (states.includes("pending")) return "pending";
    return states.length > 0 && states.every((s) => s === "pass") ? "pass" : "none";
  }
}
