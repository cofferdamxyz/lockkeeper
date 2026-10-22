import config, { type AdviseConfig } from "../../../lockkeeper.config";
import type { AdviseEnv } from "./env";
import { cleanPaths } from "./paths";
import { activeClaims, addClaim, getClaim, releaseClaim, renewClaim, type ClaimRow } from "./store";
import { claimText, claimVectorId, remove, upsert } from "./vectorIndex";

/**
 * Claims cover the window before a branch exists on GitHub (DESIGN.md §12): "I am about to
 * work on these paths". They expire on their own, are released when their branch is pushed,
 * and never stop anyone: another session reads them as a fact.
 */

export class ClaimError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

export interface ClaimInput {
  repo: unknown;
  paths?: unknown;
  goal?: unknown;
  branch?: unknown;
  session?: unknown;
  ttl_minutes?: unknown;
}

function newClaimId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `cl-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function ttl(input: unknown, settings: AdviseConfig): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || n <= 0) return settings.claims.defaultMinutes;
  return Math.min(Math.round(n), settings.claims.maxMinutes);
}

export function repoName(input: unknown, owner: string): string {
  if (typeof input !== "string" || !input.trim()) throw new ClaimError(400, "repo is required (owner/name or name)");
  const r = input.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const full = r.includes("/") ? r : `${owner}/${r}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(full)) throw new ClaimError(400, `not a repository: ${input}`);
  return full;
}

export async function createClaim(
  env: AdviseEnv,
  who: string,
  input: ClaimInput,
  opts: { now?: Date; settings?: AdviseConfig } = {},
): Promise<ClaimRow> {
  const settings = opts.settings ?? config.advise;
  const now = opts.now ?? new Date();
  const goal = typeof input.goal === "string" ? input.goal.trim().slice(0, 500) : "";
  if (!goal) throw new ClaimError(400, "goal is required: one sentence on what the work is");
  const claim: ClaimRow = {
    id: newClaimId(),
    repo: repoName(input.repo, settings.owner),
    paths: cleanPaths(input.paths, 200),
    goal,
    who,
    session: typeof input.session === "string" ? input.session.slice(0, 120) : null,
    branch: typeof input.branch === "string" && input.branch.trim() ? input.branch.trim().slice(0, 250) : null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl(input.ttl_minutes, settings) * 60_000).toISOString(),
    released_at: null,
  };
  await addClaim(env, claim);
  await upsert(env, [{ id: claimVectorId(claim.id), text: claimText(claim), meta: { kind: "claim", repo: claim.repo, name: claim.id } }]).catch(
    (err) => console.warn("claim not indexed", err instanceof Error ? err.message : String(err)),
  );
  return claim;
}

async function owned(env: AdviseEnv, id: string, who: string): Promise<ClaimRow> {
  const c = await getClaim(env, id);
  if (!c) throw new ClaimError(404, "no such claim");
  // Anyone may read a claim; only its owner renews or releases it.
  if (c.who !== who) throw new ClaimError(403, "the claim belongs to another identity");
  return c;
}

export async function extendClaim(env: AdviseEnv, who: string, id: string, minutes: unknown, opts: { now?: Date; settings?: AdviseConfig } = {}): Promise<ClaimRow> {
  const settings = opts.settings ?? config.advise;
  const now = opts.now ?? new Date();
  await owned(env, id, who);
  const ok = await renewClaim(env, id, new Date(now.getTime() + ttl(minutes, settings) * 60_000).toISOString(), now.toISOString());
  if (!ok) throw new ClaimError(404, "the claim has expired or was released; take a new one");
  return (await getClaim(env, id))!;
}

export async function dropClaim(env: AdviseEnv, who: string, id: string, now = new Date()): Promise<void> {
  await owned(env, id, who);
  await releaseClaim(env, id, "released", now.toISOString());
  await remove(env, [claimVectorId(id)]).catch(() => undefined);
}

export async function listClaims(env: AdviseEnv, repo: string | undefined, now = new Date()): Promise<ClaimRow[]> {
  return activeClaims(env, now.toISOString(), repo);
}
