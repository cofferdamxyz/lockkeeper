import type { LockkeeperEnv } from "./env";
import { putToken } from "./db";

/** The project repository and its `main`, as the Worker sees it through the binding. */
export async function projectRepo(env: LockkeeperEnv, repo: string): Promise<ArtifactsRepo> {
  return env.ARTIFACTS.get(repo);
}

export function forkName(taskId: string): string {
  return `task-${taskId}`;
}

/** Fork the project repository for one task. The fork carries only the default branch. */
export async function forkForTask(
  env: LockkeeperEnv,
  repo: string,
  taskId: string,
): Promise<{ name: string; remote: string }> {
  const source = await env.ARTIFACTS.get(repo);
  const name = forkName(taskId);
  const created = await source.fork(name, { defaultBranchOnly: true, description: `Lockkeeper task ${taskId}` });
  return { name, remote: created.remote };
}

/**
 * Mint a short-lived token for a repository and register it for a sandbox. The sandbox never
 * sees the token: the outbound gateway adds it to requests for that repository's git URL.
 */
export async function grantRepoToken(
  env: LockkeeperEnv,
  sandbox: string,
  repo: string,
  scope: "read" | "write",
  ttlSeconds: number,
): Promise<void> {
  const r = await env.ARTIFACTS.get(repo);
  const token = await r.createToken(scope, ttlSeconds);
  const expiresAt =
    typeof token.expiresAt === "string"
      ? token.expiresAt
      : new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await putToken(env.DB, sandbox, repo, token.plaintext, expiresAt);
}

export async function deleteRepo(env: LockkeeperEnv, name: string): Promise<boolean> {
  return env.ARTIFACTS.delete(name);
}

export async function headSha(env: LockkeeperEnv, repo: string, ref = "HEAD"): Promise<string | null> {
  const r = await env.ARTIFACTS.get(repo);
  const log = await r.log({ ref, limit: 1 });
  return log[0]?.hash ?? null;
}

/** Walk the tree of a ref and return text files under a size cap, for the repository map. */
export async function listFiles(
  env: LockkeeperEnv,
  repo: string,
  ref: string,
  opts: { maxFiles?: number; maxBytes?: number } = {},
): Promise<{ path: string; text: string }[]> {
  const r = await env.ARTIFACTS.get(repo);
  const commit = await r.readCommit(ref);
  if (!commit) return [];
  const out: { path: string; text: string }[] = [];
  const maxFiles = opts.maxFiles ?? 400;
  const maxBytes = opts.maxBytes ?? 48_000;
  const skip = /(^|\/)(node_modules|dist|out|\.git|\.wrangler|coverage)(\/|$)|\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|lock|pdf)$|pnpm-lock\.yaml$|package-lock\.json$/i;

  async function walk(treeHash: string, prefix: string): Promise<void> {
    if (out.length >= maxFiles) return;
    const entries = await r.readTree(treeHash);
    if (!entries) return;
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (skip.test(path)) continue;
      if (e.type === "tree") {
        await walk(e.hash, path);
      } else if (e.type === "blob") {
        const blob = await r.readBlob(e.hash);
        if (!blob || blob.size > maxBytes) continue;
        const text = await blob.text();
        if (text.includes("\u0000")) continue;
        out.push({ path, text });
      }
    }
  }
  await walk(commit.treeHash, "");
  return out;
}
