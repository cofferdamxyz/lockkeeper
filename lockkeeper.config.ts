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
  /** How a decided change reaches the system of record. */
  mergeMode: "mirror" | "pull-request";
}

export interface LockkeeperConfig {
  projects: ProjectConfig[];
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
      test: "npm test",
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
  agents: {
    model: "claude-sonnet-5-5",
    maxMinutes: 25,
    allowedHosts: ["gateway.ai.cloudflare.com", "registry.npmjs.org"],
  },
};

export default config;
