import { embed } from "../vectors";
import type { AdviseEnv } from "./env";
import type { BranchRow, ClaimRow } from "./store";

/**
 * The index over GitHub (DESIGN.md §5 and §12): one vector per branch in flight and one per
 * claim, bge-m3 as in the demo. Metadata `repo` and `kind` are filterable (the founder creates
 * the metadata indexes with the index). Rebuildable: the poller re-embeds any branch whose head moved.
 */

export interface IndexMeta {
  kind: "branch" | "claim";
  repo: string;
  name: string;
}

/** Vectorize ids stop at 64 bytes and branch names do not, so a branch's id is a hash. */
export async function branchVectorId(repo: string, name: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${repo}\n${name}`)));
  return `b:${Array.from(d.slice(0, 20), (x) => x.toString(16).padStart(2, "0")).join("")}`;
}
export const claimVectorId = (id: string) => `c:${id}`;

export function branchText(b: Pick<BranchRow, "repo" | "name" | "pr_title" | "commits" | "files">): string {
  const parts = [`Repository: ${b.repo}`, `Branch: ${b.name}`];
  if (b.pr_title) parts.push(`Pull request: ${b.pr_title}`);
  if (b.commits.length) parts.push(`Commits: ${b.commits.slice(-20).join(" | ")}`);
  if (b.files.length) parts.push(`Files: ${b.files.slice(0, 200).join(", ")}`);
  return parts.join("\n");
}

export function claimText(c: Pick<ClaimRow, "repo" | "goal" | "paths">): string {
  return [`Repository: ${c.repo}`, `Goal: ${c.goal}`, c.paths.length ? `Paths: ${c.paths.join(", ")}` : ""].filter(Boolean).join("\n");
}

export function indexReady(env: Pick<AdviseEnv, "AI" | "VECTORIZE">): boolean {
  return Boolean(env.AI && env.VECTORIZE);
}

export async function embedTexts(env: Pick<AdviseEnv, "AI">, texts: string[]): Promise<number[][]> {
  if (!env.AI || texts.length === 0) return [];
  return embed({ AI: env.AI }, texts);
}

export async function upsert(
  env: Pick<AdviseEnv, "AI" | "VECTORIZE">,
  items: { id: string; text: string; meta: IndexMeta }[],
): Promise<void> {
  if (!indexReady(env) || items.length === 0) return;
  const values = await embedTexts(env, items.map((i) => i.text));
  const vectors = items.map((i, k) => ({ id: i.id, values: values[k], metadata: { ...i.meta } }));
  for (let i = 0; i < vectors.length; i += 100) {
    await env.VECTORIZE!.upsert(vectors.slice(i, i + 100) as unknown as VectorizeVector[]);
  }
}

export async function remove(env: Pick<AdviseEnv, "VECTORIZE">, ids: string[]): Promise<void> {
  if (!env.VECTORIZE || ids.length === 0) return;
  await env.VECTORIZE.deleteByIds(ids);
}

/** Cosine similarity of `text` to everything in flight in `repo`, by vector id. */
export async function similarity(
  env: Pick<AdviseEnv, "AI" | "VECTORIZE">,
  repo: string,
  text: string,
  topK = 20,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!indexReady(env) || !text.trim()) return out;
  const [values] = await embedTexts(env, [text]);
  if (!values) return out;
  const res = await env.VECTORIZE!.query(values, { topK, filter: { repo }, returnMetadata: "none" });
  for (const m of res.matches) out.set(m.id, m.score);
  return out;
}
