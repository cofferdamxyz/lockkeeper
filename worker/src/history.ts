import { getProject } from "./db";
import type { LockkeeperEnv } from "./env";
import { projectPosition } from "./repomap";
import { type Basis, embed, project as projectVector, upsertVectors } from "./vectors";

export interface CommitMeta {
  sha: string;
  message: string;
  author: string | null;
  at: string;
  parents: string[];
  files: string[];
  task: string | null;
  merge: boolean;
}

const SKIP = /(^|\/)(node_modules|dist|out|\.git|\.wrangler|coverage)(\/|$)/;

/** Flatten a tree into path → blob hash, capped so a huge repository cannot stall a request. */
async function flatten(repo: ArtifactsRepo, treeHash: string, cap = 2000): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(hash: string, prefix: string): Promise<void> {
    if (out.size >= cap) return;
    const entries = await repo.readTree(hash);
    if (!entries) return;
    for (const e of entries) {
      if (out.size >= cap) return;
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (SKIP.test(path)) continue;
      if (e.type === "tree") await walk(e.hash, path);
      else if (e.type === "blob" || e.type === "exec") out.set(path, e.hash);
    }
  }
  await walk(treeHash, "");
  return out;
}

/** Paths whose blob changed between a commit and its first parent. */
export async function changedFiles(repo: ArtifactsRepo, commit: ArtifactsCommitMetadata): Promise<string[]> {
  const after = await flatten(repo, commit.treeHash);
  const parentHash = commit.parents[0];
  if (!parentHash) return [...after.keys()].slice(0, 60);
  const parent = await repo.readCommit(parentHash);
  if (!parent) return [...after.keys()].slice(0, 60);
  const before = await flatten(repo, parent.treeHash);
  const changed: string[] = [];
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return changed.slice(0, 60);
}

function taskFromTrailers(message: string): string | null {
  const m = /^Lockkeeper-Task:\s*(\S+)/m.exec(message);
  return m ? m[1] : null;
}

/**
 * Every commit on the default branch becomes a point: embedded from its message and files,
 * then pulled toward the files it touched so it sits in their neighbourhood. Idempotent.
 */
export async function indexCommitHistory(env: LockkeeperEnv, projectId: string, basis: Basis, limit = 400): Promise<{ indexed: number; total: number }> {
  const project = await getProject(env.DB, projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  const repo = await env.ARTIFACTS.get(project.repo);
  // The log follows first parents; the agents' own commits sit on the merged branches, so walk
  // every merge's other parents back to the mainline.
  const mainline = await repo.log({ ref: project.default_branch, limit });
  const onMain = new Set(mainline.map((c) => c.hash));
  const log: ArtifactsCommitMetadata[] = [...mainline];
  const queue = mainline.flatMap((c) => c.parents.slice(1));
  const seen = new Set<string>(onMain);
  while (queue.length > 0 && log.length < limit * 2) {
    const hash = queue.shift()!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const c = await repo.readCommit(hash);
    if (!c) continue;
    log.push(c);
    for (const p of c.parents) if (!seen.has(p)) queue.push(p);
  }
  // Rows written before commits carried a timestamp are indexed again.
  const existing = new Set(
    (await env.DB.prepare("SELECT id, meta_json FROM positions WHERE project = ? AND kind = 'commit'").bind(projectId).all<{ id: string; meta_json: string | null }>()).results
      .filter((r) => r.meta_json && (JSON.parse(r.meta_json) as { at?: string }).at)
      .map((r) => r.id),
  );
  const fresh = log.filter((c) => !existing.has(`commit:${projectId}:${c.hash}`));
  if (fresh.length === 0) return { indexed: 0, total: log.length };
  const filePositions = new Map<string, [number, number, number]>();
  const rows = await env.DB.prepare("SELECT label, x, y, z FROM positions WHERE project = ? AND kind = 'file'").bind(projectId).all<{ label: string; x: number; y: number; z: number }>();
  for (const r of rows.results) filePositions.set(r.label, [r.x, r.y, r.z]);
  const tasksByHead = new Map(
    (await env.DB.prepare("SELECT id, head_sha FROM tasks WHERE project = ? AND head_sha IS NOT NULL").bind(projectId).all<{ id: string; head_sha: string }>()).results.map((t) => [t.head_sha, t.id]),
  );
  const metas: CommitMeta[] = [];
  for (const c of fresh) {
    const files = await changedFiles(repo, c);
    metas.push({
      sha: c.hash,
      message: c.message,
      author: c.author?.name ?? null,
      at: new Date(c.committedAt * 1000).toISOString(),
      parents: c.parents,
      files,
      task: taskFromTrailers(c.message) ?? tasksByHead.get(c.hash) ?? null,
      merge: c.parents.length > 1,
    });
  }
  const vectors = await embed(
    env,
    metas.map((m) => `Commit: ${m.message.split("\n")[0].slice(0, 200)}\nFiles: ${m.files.slice(0, 30).join(", ")}`),
  );
  await upsertVectors(
    env,
    metas.map((m, i) => ({
      id: `commit:${projectId}:${m.sha}`,
      values: vectors[i],
      metadata: { kind: "commit" as const, project: projectId, task: m.task ?? undefined, status: "merged", paths: m.files.slice(0, 40).join(","), label: m.message.split("\n")[0].slice(0, 200) },
    })),
  );
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    let [x, y, z] = projectVector(basis, vectors[i]);
    const touched = m.files.map((f) => filePositions.get(f)).filter((p): p is [number, number, number] => p !== undefined);
    if (touched.length > 0) {
      const cx = touched.reduce((s, p) => s + p[0], 0) / touched.length;
      const cy = touched.reduce((s, p) => s + p[1], 0) / touched.length;
      const cz = touched.reduce((s, p) => s + p[2], 0) / touched.length;
      x = x * 0.45 + cx * 0.55;
      y = y * 0.45 + cy * 0.55;
      z = z * 0.45 + cz * 0.55;
    }
    await env.DB.prepare(
      `INSERT INTO positions (id, project, kind, label, x, y, z, meta_json) VALUES (?, ?, 'commit', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z, label = excluded.label, meta_json = excluded.meta_json`,
    )
      .bind(`commit:${projectId}:${m.sha}`, projectId, m.message.split("\n")[0].slice(0, 120), x, y, z, JSON.stringify(m))
      .run();
  }
  return { indexed: metas.length, total: log.length };
}

export async function commitDetail(env: LockkeeperEnv, projectId: string, sha: string): Promise<(CommitMeta & { body: string; position: { x: number; y: number; z: number } | null }) | null> {
  const project = await getProject(env.DB, projectId);
  if (!project) return null;
  const repo = await env.ARTIFACTS.get(project.repo);
  const c = await repo.readCommit(sha);
  if (!c) return null;
  const row = await env.DB.prepare("SELECT x, y, z, meta_json FROM positions WHERE id = ?").bind(`commit:${projectId}:${sha}`).first<{ x: number; y: number; z: number; meta_json: string | null }>();
  const meta = row?.meta_json ? (JSON.parse(row.meta_json) as Partial<CommitMeta>) : {};
  const files = meta.files ?? (await changedFiles(repo, c));
  return {
    sha,
    message: c.message.split("\n")[0],
    body: c.message,
    author: c.author?.name ?? null,
    at: new Date(c.committedAt * 1000).toISOString(),
    parents: c.parents,
    files,
    task: meta.task ?? taskFromTrailers(c.message),
    merge: c.parents.length > 1,
    position: row ? { x: row.x, y: row.y, z: row.z } : null,
  };
}

export async function fileDetail(env: LockkeeperEnv, projectId: string, path: string): Promise<{ path: string; text: string | null; bytes: number; truncated: boolean; commits: { sha: string; message: string; at: string; task: string | null }[] } | null> {
  const project = await getProject(env.DB, projectId);
  if (!project) return null;
  const repo = await env.ARTIFACTS.get(project.repo);
  const blob = await repo.readFile({ ref: project.default_branch, path });
  if (!blob) return null;
  const cap = 200_000;
  const raw = await blob.slice(0, cap).text();
  const text = raw.includes("\u0000") ? null : raw;
  const rows = await env.DB.prepare("SELECT meta_json FROM positions WHERE project = ? AND kind = 'commit'").bind(projectId).all<{ meta_json: string | null }>();
  const commits = rows.results
    .map((r) => (r.meta_json ? (JSON.parse(r.meta_json) as CommitMeta) : null))
    .filter((m): m is CommitMeta => m !== null && Array.isArray(m.files) && m.files.includes(path))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, 30)
    .map((m) => ({ sha: m.sha, message: m.message.split("\n")[0], at: m.at, task: m.task }));
  return { path, text, bytes: blob.size, truncated: blob.size > cap, commits };
}
