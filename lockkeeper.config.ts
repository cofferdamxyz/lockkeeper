// Per-organisation configuration. Non-secret. Secrets go through `wrangler secret put`.
export interface ProjectConfig {
  /** Short id used in URLs and the ledger. */
  id: string;
  /** Artifacts repository name inside the deployment's namespace. */
  repo: string;
  /** GitHub repository that mirrors `main`, as owner/name. Optional. */
  github?: string;
  defaultBranch: string;
  /** Path, inside the repository, of the conventions file agents read first. */
  conventions: string;
  /** Command the harness and the merge sandbox run before a change is ready or merged. */
  test: string;
  /** How a decided change reaches the system of record. `advise` lives in `advise` below: no runner, no merge. */
  mergeMode: "mirror" | "pull-request";
}

/**
 * The advisory deployment (`worker/wrangler.cofferdam.jsonc`, DESIGN.md §12–§13): it reads GitHub
 * through its own GitHub App, keeps the index and claims, and advises. It never launches an agent
 * and never merges, so nothing here names a sandbox, a fork or a merge mode.
 */
export interface AdviseConfig {
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
}

export interface LockkeeperConfig {
  projects: ProjectConfig[];
  advise: AdviseConfig;
  clef: {
    /** `clef` for the merge decision; `clef-flash` is enough for cheap, frequent questions. */
    model: "clef" | "clef-flash";
    /** Minimum P(yes) for an unattended merge. */
    unattended: number;
    /** Minimum P(yes) after a resolver agent touched the change. */
    unattendedAfterResolve: number;
    /** Maximum probability-weighted risk (0 = none, 3 = critical) for an unattended merge. */
    maxRisk: number;
    /** Largest ready set sent to Clef in one request. */
    maxCandidates: number;
  };
  agents: {
    model: string;
    /** Hard cap on the agent's own task run, in minutes. */
    maxMinutes: number;
    /** Hosts the sandbox may reach; the outbound gateway rejects everything else. */
    allowedHosts: string[];
  };
}

const config: LockkeeperConfig = {
  projects: [
    {
      id: "sample-api",
      repo: "sample-api",
      defaultBranch: "main",
      conventions: "AGENTS.md",
      test: "npm install --no-audit --no-fund --silent && npm test",
      mergeMode: "mirror",
    },
  ],
  clef: {
    model: "clef",
    unattended: 0.8,
    unattendedAfterResolve: 0.9,
    maxRisk: 1.0,
    maxCandidates: 20,
  },
  // Cofferdam's advisory deployment (workspace decision 0053). The sensitive list names the real
  // paths (corrected 2026-10-22: the decision's `cofferdam-api/src/auth/**` matched nothing):
  // the plane's session attestation, authority checks, ceremonies, Self binding, user operations
  // and relay; the whole attester; the app's passkey, recovery phrase and wallet; the contracts;
  // every Worker config and the OS deployment and deploy script; and every CI workflow, because
  // CI is the evidence and a change to it must never go unattended.
  advise: {
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
    ],
    staleDays: 14,
    claims: { defaultMinutes: 60, maxMinutes: 240 },
    nearCosine: 0.6,
    recentHours: 24,
  },
  agents: {
    model: "claude-sonnet-5-5",
    maxMinutes: 25,
    allowedHosts: ["gateway.ai.cloudflare.com", "registry.npmjs.org"],
  },
};

export default config;
