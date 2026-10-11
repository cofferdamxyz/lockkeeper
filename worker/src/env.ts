import type { AgentSandbox } from "./sandbox";
import type { MergeWorkflow } from "./workflow";

/**
 * Bindings and variables the Worker, the Durable Object, the Workflow and the
 * outbound gateway share. `wrangler types` generates the global `Env`; this
 * interface pins the shape the code relies on so it type-checks before the
 * generated file exists.
 */
export interface LockkeeperEnv {
  ARTIFACTS: Artifacts;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  SANDBOX: DurableObjectNamespace<AgentSandbox>;
  MERGE_WORKFLOW: Workflow;
  ASSETS: Fetcher;

  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  ARTIFACTS_NAMESPACE: string;
  CLAUDE_CODE_VERSION: string;

  AI_GATEWAY_TOKEN: string;
  DASHBOARD_TOKEN: string;
  GITHUB_DEPLOY_KEY?: string;
}

export const GATEWAY_HOST = "gateway.ai.cloudflare.com";
export const NPM_HOST = "registry.npmjs.org";

export function artifactsHost(env: Pick<LockkeeperEnv, "AI_GATEWAY_ACCOUNT_ID">): string {
  // The git host for the account: https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<ns>/<repo>.git
  return `${env.AI_GATEWAY_ACCOUNT_ID}.artifacts.cloudflare.net`;
}
