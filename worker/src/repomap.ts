import { headSha, listFiles } from "./artifacts";
import { getProject } from "./db";
import type { LockkeeperEnv } from "./env";
import { type Basis, embed, fileVectorId, fitBasis, project as projectVector, upsertVectors } from "./vectors";

/**
 * The repository map: every file of the project's default branch embedded, placed on a fixed
 * three-axis basis and stored both in the index (for similarity) and in D1 (for the dashboard).
 */
export async function indexProject(env: LockkeeperEnv, projectId: string, opts: { refit?: boolean } = {}): Promise<{ files: number; head: string | null; refit: boolean }> {
  const project = await getProject(env.DB, projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  const head = await headSha(env, project.repo, project.default_branch);
  const files = await listFiles(env, project.repo, project.default_branch);
  if (files.length === 0) return { files: 0, head, refit: false };
  const vectors = await embed(
    env,
    files.map((f) => `${f.path}\n${f.text.slice(0, 6000)}`),
  );
  let basis: Basis | null = project.basis_json && !opts.refit ? (JSON.parse(project.basis_json) as Basis) : null;
  let refit = false;
  if (!basis) {
    basis = fitBasis(vectors);
    refit = true;
    await env.DB.prepare("UPDATE projects SET basis_json = ? WHERE id = ?").bind(JSON.stringify(basis), projectId).run();
  }
  const ids = files.map((f) => fileVectorId(projectId, f.path));
  const statements = files.map((f, i) => {
    const [x, y, z] = projectVector(basis!, vectors[i]);
    return env.DB.prepare(
      `INSERT INTO positions (id, project, kind, label, x, y, z, meta_json) VALUES (?, ?, 'file', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z, label = excluded.label,
         meta_json = excluded.meta_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).bind(ids[i], projectId, f.path, x, y, z, JSON.stringify({ dir: f.path.includes("/") ? f.path.split("/")[0] : ".", bytes: f.text.length }));
  });
  for (let i = 0; i < statements.length; i += 40) await env.DB.batch(statements.slice(i, i + 40));
  // Drop map points for files that no longer exist on main.
  const existing = await env.DB.prepare("SELECT id FROM positions WHERE project = ? AND kind = 'file'").bind(projectId).all<{ id: string }>();
  const keep = new Set(ids);
  const stale = existing.results.map((r) => r.id).filter((id) => !keep.has(id));
  for (let i = 0; i < stale.length; i += 40) {
    await env.DB.batch(stale.slice(i, i + 40).map((id) => env.DB.prepare("DELETE FROM positions WHERE id = ?").bind(id)));
  }
  if (stale.length && env.VECTORIZE) await env.VECTORIZE.deleteByIds(stale);
  await upsertVectors(
    env,
    files.map((f, i) => ({
      id: ids[i],
      values: vectors[i],
      metadata: { kind: "file", project: projectId, label: f.path, paths: f.path },
    })),
  );
  await env.DB.prepare("UPDATE projects SET head_sha = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(head, projectId).run();
  return { files: files.length, head, refit };
}

/** Place one vector (a task revision) on the project's basis. No-op until the map exists. */
export async function projectPosition(
  env: LockkeeperEnv,
  projectId: string,
  p: { id: string; kind: "task" | "file" | "commit"; label: string; values: number[]; meta: Record<string, unknown> },
): Promise<void> {
  const project = await getProject(env.DB, projectId);
  if (!project?.basis_json) return;
  const basis = JSON.parse(project.basis_json) as Basis;
  const [x, y, z] = projectVector(basis, p.values);
  await env.DB.prepare(
    `INSERT INTO positions (id, project, kind, label, x, y, z, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z, label = excluded.label,
       meta_json = excluded.meta_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(p.id, projectId, p.kind, p.label, x, y, z, JSON.stringify(p.meta))
    .run();
}
