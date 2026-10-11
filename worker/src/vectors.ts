import type { LockkeeperEnv } from "./env";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const DIMENSIONS = 1024;

export async function embed(env: Pick<LockkeeperEnv, "AI">, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  // bge-m3 accepts batches; keep them small so a long file never starves the others.
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => t.slice(0, 8_000));
    const res = (await env.AI.run(EMBEDDING_MODEL as never, { text: batch } as never)) as unknown as { data: number[][] };
    out.push(...res.data);
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export interface Basis {
  mean: number[];
  axes: number[][]; // 3 unit vectors of length DIMENSIONS
  scale: number;
}

/**
 * Top-3 principal components by power iteration with deflation. A few hundred vectors of
 * 1024 dimensions finish in milliseconds, which is all the repository map needs.
 */
export function fitBasis(vectors: number[][], iterations = 60): Basis {
  const n = vectors.length;
  const d = vectors[0]?.length ?? DIMENSIONS;
  const mean = new Array<number>(d).fill(0);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  const centered = vectors.map((v) => v.map((x, i) => x - mean[i]));
  const axes: number[][] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let k = 0; k < 3; k++) {
    let w = new Array<number>(d).fill(0).map(() => rand());
    normalize(w);
    for (let it = 0; it < iterations; it++) {
      const next = new Array<number>(d).fill(0);
      for (const v of centered) {
        const proj = dot(v, w);
        for (let i = 0; i < d; i++) next[i] += proj * v[i];
      }
      // Deflate against the axes already found.
      for (const a of axes) {
        const p = dot(next, a);
        for (let i = 0; i < d; i++) next[i] -= p * a[i];
      }
      if (normalize(next) === 0) break;
      w = next;
    }
    axes.push(w);
  }
  // Scale so the cloud spans roughly [-1, 1] on its first axis.
  let maxAbs = 1e-6;
  for (const v of centered) maxAbs = Math.max(maxAbs, Math.abs(dot(v, axes[0])));
  return { mean, axes, scale: 1 / maxAbs };
}

export function project(basis: Basis, v: number[]): [number, number, number] {
  const c = v.map((x, i) => x - basis.mean[i]);
  return [
    dot(c, basis.axes[0]) * basis.scale,
    dot(c, basis.axes[1]) * basis.scale,
    dot(c, basis.axes[2]) * basis.scale,
  ];
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function normalize(v: number[]): number {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return 0;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return n;
}

export interface TaskVectorMeta {
  kind: "task" | "file";
  project: string;
  task?: string;
  status?: string;
  paths?: string;
  label: string;
}

export function taskVectorId(taskId: string): string {
  return `task:${taskId}`;
}

export function fileVectorId(project: string, path: string): string {
  return `file:${project}:${path}`;
}

/** What a task embeds as: its goal, then the real work once a diff exists. */
export function taskText(t: { goal: string; files?: string[]; diffstat?: string | null; commits?: string[]; summary?: string | null }): string {
  const parts = [`Goal: ${t.goal}`];
  if (t.files && t.files.length) parts.push(`Files: ${t.files.join(", ")}`);
  if (t.commits && t.commits.length) parts.push(`Commits: ${t.commits.join(" | ")}`);
  if (t.diffstat) parts.push(`Diffstat: ${t.diffstat.slice(0, 1500)}`);
  if (t.summary) parts.push(`Summary: ${t.summary.slice(0, 1500)}`);
  return parts.join("\n");
}

export async function upsertVectors(
  env: Pick<LockkeeperEnv, "VECTORIZE">,
  vectors: { id: string; values: number[]; metadata: TaskVectorMeta }[],
): Promise<void> {
  if (!env.VECTORIZE) return;
  for (let i = 0; i < vectors.length; i += 100) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 100) as unknown as VectorizeVector[]);
  }
}

export interface Neighbor {
  id: string;
  score: number;
  metadata: TaskVectorMeta;
}

export async function nearest(
  env: Pick<LockkeeperEnv, "VECTORIZE">,
  values: number[],
  filter: Record<string, string>,
  topK = 5,
): Promise<Neighbor[]> {
  if (!env.VECTORIZE) return [];
  const res = await env.VECTORIZE.query(values, { topK, filter, returnMetadata: "all" });
  return res.matches.map((m) => ({ id: m.id, score: m.score, metadata: m.metadata as unknown as TaskVectorMeta }));
}

export async function getVectors(env: Pick<LockkeeperEnv, "VECTORIZE">, ids: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (ids.length === 0 || !env.VECTORIZE) return out;
  const res = await env.VECTORIZE.getByIds(ids);
  for (const v of res) out.set(v.id, Array.from(v.values as number[]));
  return out;
}
