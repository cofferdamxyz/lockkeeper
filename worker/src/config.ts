// The shape of Lockkeeper's configuration and its defaults (DESIGN.md, "Configuration"). An
// organisation's own values live in one file, `lockkeeper.config.ts` at the repository root,
// which calls `defineConfig`; nothing under `worker/src` names an organisation. Secrets never
// live in either file: they go through `wrangler secret put`.

/** Where the state of CI on a pull request's head is read from. */
export type CiSource = "checks" | "comment";

export interface LockkeeperConfig {
  /** GitHub organisation (or user) the App is installed on. */
  owner: string;
  /** Repositories (names, without the owner) the App can see but the index skips. Empty: all of them. */
  exclude: string[];
  /**
   * Globs, `<repo>/<path>`, a change may never touch and still be unattended-eligible. `*` stays
   * inside one path segment, `**` crosses segments; a leading `**` matches every repository.
   */
  sensitive: string[];
  /** A branch with no commit for this many days drops out of "in flight" unless a pull request is open. */
  staleDays: number;
  claims: { defaultMinutes: number; maxMinutes: number };
  /** Minimum cosine similarity for a change with no shared path to count as near. */
  nearCosine: number;
  /** Window for "landed on main recently" in briefs. */
  recentHours: number;
  /** Clef's advice on the open pull requests (DESIGN.md, "The advising pass"). */
  advice: {
    /** Write the advice as one comment per candidate pull request (needs pull-request write on the App). */
    comment: boolean;
    /** Hours to wait before trying comments again after GitHub refused one (a missing permission). */
    retryHours: number;
    /** The label the advice suggests for a change that touches a sensitive path; null suggests none. Never applied. */
    sensitiveLabel: string | null;
  };
  /** How the state of CI on a head is learned (DESIGN.md, "The poller and the index"). */
  ci: {
    /**
     * Every source named here is read, and every one must say passed for a head to be green: a
     * source with nothing to say about the head holds it at "unknown". `checks` reads the head's
     * check runs (the App needs Checks read). `comment` reads a comment a CI job keeps on the
     * pull request. Name only the sources your repositories all report through.
     */
    sources: CiSource[];
    /**
     * Check runs that must have succeeded on the head for it to be green, by name; `*` stands for
     * any run of characters. Without one, any single successful run makes a head green, including
     * one from a check that is not your CI: name your CI job here.
     */
    requireChecks: string[];
    /** Check runs that never count, by name, with the same `*`. */
    ignoreChecks: string[];
    /** How the CI comment's first line opens, up to the job's name: `<!-- lockkeeper-ci:` for `<!-- lockkeeper-ci:test -->`. */
    commentMarker: string;
    /** Hours to wait before asking for check runs again after GitHub refused (a missing permission). */
    retryHours: number;
  };
  /**
   * How a branch names its issue: a pattern whose first group is the issue's number, and the
   * repository the issues live in. A branch that does not match is bound to nothing; null binds none.
   */
  issues: { repo: string; branch: string } | null;
  clef: {
    /** `clef` for the landing decision; `clef-flash` is enough for cheap, frequent questions. */
    model: "clef" | "clef-flash";
    /** Minimum P(yes) for a pull request to read as unattended-eligible. */
    unattended: number;
    /** Maximum probability-weighted risk (0 = none, 3 = critical) for the same verdict. */
    maxRisk: number;
    /** Largest set of open pull requests sent to Clef in one request. */
    maxCandidates: number;
  };
}

/**
 * What holds for an organisation that says nothing else. CI workflows are sensitive by default,
 * because CI is the evidence: a pull request that edits its own workflow can make any check green.
 */
export const defaults: Omit<LockkeeperConfig, "owner"> = {
  exclude: [],
  sensitive: ["**/.github/workflows/**"],
  staleDays: 14,
  claims: { defaultMinutes: 60, maxMinutes: 240 },
  nearCosine: 0.6,
  recentHours: 24,
  advice: { comment: true, retryHours: 6, sensitiveLabel: "security" },
  ci: { sources: ["checks"], requireChecks: [], ignoreChecks: [], commentMarker: "<!-- lockkeeper-ci:", retryHours: 6 },
  issues: null,
  clef: { model: "clef", unattended: 0.8, maxRisk: 1.0, maxCandidates: 20 },
};

/**
 * An organisation's values: `owner`, and whatever differs from the defaults. A group (`ci`,
 * `advice`, `claims`, `clef`) may be given in part; a list replaces the default list; `issues`
 * is given whole or not at all.
 */
export type OrganisationConfig = { owner: string } & {
  [K in Exclude<keyof LockkeeperConfig, "owner" | "issues">]?: LockkeeperConfig[K] extends unknown[] ? LockkeeperConfig[K] : LockkeeperConfig[K] extends object ? Partial<LockkeeperConfig[K]> : LockkeeperConfig[K];
} & { issues?: LockkeeperConfig["issues"] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * The defaults with an organisation's values over them, merged one level deep. An `undefined`
 * never replaces a default, and the result shares nothing with `defaults`.
 */
export function defineConfig(org: OrganisationConfig): LockkeeperConfig {
  const out = structuredClone(defaults) as Record<string, unknown>;
  for (const [key, value] of Object.entries(defined(org as Record<string, unknown>))) {
    const base = out[key];
    out[key] = isRecord(value) && isRecord(base) ? { ...base, ...defined(value) } : structuredClone(value);
  }
  return out as unknown as LockkeeperConfig;
}
