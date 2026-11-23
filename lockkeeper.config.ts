// Lockkeeper's configuration: non-secret, typed, one deployment per organisation. Secrets go
// through `wrangler secret put` (DESIGN.md, "Access and identity").
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
  };
  /**
   * How a branch names its issue: the dispatch routine pushes `claude/<issue>-<slug>`, and the
   * issues live in one repository. A branch that does not match is bound to nothing.
   */
  issues: { repo: string; branch: string };
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

// Cofferdam's deployment (workspace decision 0053). The sensitive list names the real paths
// (corrected 2026-10-22: the decision's `cofferdam-api/src/auth/**` matched nothing): the plane's
// session attestation, authority checks, ceremonies, Self binding, user operations and relay; the
// whole attester; the app's passkey, recovery phrase and wallet; the contracts; every Worker
// config and the OS deployment and deploy script; every CI workflow, because CI is the evidence
// and a change to it must never go unattended; and Lockkeeper's own source and this file, because
// the guard test over its GitHub writes is a tripwire, not a proof.
const config: LockkeeperConfig = {
  owner: "cofferdamxyz",
  exclude: ["cofferdam-prover"],
  sensitive: [
    "cofferdam-api/src/env.ts",
    "cofferdam-api/src/services/sessionAttestation.ts",
    "cofferdam-api/src/services/authorityCheck.ts",
    "cofferdam-api/src/services/ceremony.ts",
    "cofferdam-api/src/services/selfBind.ts",
    "cofferdam-api/src/services/userOp.ts",
    "cofferdam-api/src/services/relaySend.ts",
    "cofferdam-api/src/routes/ceremony.ts",
    "cofferdam-api/src/routes/session.ts",
    "cofferdam-api/src/routes/aa.ts",
    "cofferdam-api/src/routes/self.ts",
    "cofferdam-attester/**",
    "cofferdam-app/src/lib/passkey.ts",
    "cofferdam-app/src/lib/recoveryPhrase.ts",
    "cofferdam-app/src/lib/wallet.ts",
    "base-contracts/**",
    "**/wrangler.jsonc",
    "**/.github/workflows/**",
    "cofferdam-os/deployment.jsonc",
    "cofferdam-os/scripts/**",
    "lockkeeper/worker/src/**",
    "lockkeeper/lockkeeper.config.ts",
  ],
  staleDays: 14,
  claims: { defaultMinutes: 60, maxMinutes: 240 },
  nearCosine: 0.6,
  recentHours: 24,
  advice: { comment: true, retryHours: 6 },
  issues: { repo: "cofferdam", branch: "^claude/(\\d+)-" },
  clef: {
    model: "clef",
    unattended: 0.8,
    maxRisk: 1.0,
    maxCandidates: 20,
  },
};

export default config;
