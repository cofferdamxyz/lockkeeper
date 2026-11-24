/**
 * The Worker's bindings (`wrangler.jsonc`). Deliberately nothing that could run an agent or
 * merge: no container, Workflow, queue, Durable Object or service binding (the guard test).
 */
export interface LockkeeperEnv {
  DB: D1Database;
  /** Workers AI for bge-m3 embeddings. Without it overlap is by path only. */
  AI?: Ai;
  /** The index. Without it overlap is by path only. */
  VECTORIZE?: VectorizeIndex;

  /** `production` behind Access; `development` with an empty `ACCESS_AUD` (`.dev.vars`) skips Access for `wrangler dev`. */
  ENVIRONMENT: string;
  GITHUB_APP_ID: string;
  /** Team domain, e.g. https://<team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's audience tag. Empty outside development: every request is refused. */
  ACCESS_AUD: string;

  /** Secret: the GitHub App's private key (PEM as GitHub hands it out). */
  GITHUB_APP_PRIVATE_KEY: string;
}
