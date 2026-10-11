import config from "../../lockkeeper.config";
import { getProject, getSetting, listTasks, type TaskRow } from "./db";
import type { LockkeeperEnv } from "./env";
import { parseMergeDecision } from "./clef";
import { SNAPSHOT_SETTING } from "./sandbox";
import { cosine, getVectors, jaccard, taskVectorId } from "./vectors";

const IN_FLIGHT = new Set(["running", "ready", "merging", "needs_review", "approved"]);

export interface Edge {
  a: string;
  b: string;
  cosine: number;
  paths: number;
}

/** Everything the dashboard renders, in one response. Diff bodies stay out; fetch a task for those. */
export async function getState(env: LockkeeperEnv, projectId: string) {
  const project = await getProject(env.DB, projectId);
  const tasks = project ? await listTasks(env.DB, projectId) : [];
  const positions = project
    ? (await env.DB.prepare("SELECT id, kind, label, x, y, z, meta_json FROM positions WHERE project = ?").bind(projectId).all<{
        id: string;
        kind: string;
        label: string;
        x: number;
        y: number;
        z: number;
        meta_json: string | null;
      }>()).results
    : [];
  const decisions = project
    ? (await env.DB.prepare("SELECT id, candidates_json, response_json, chosen, error, at FROM decisions WHERE project = ? ORDER BY at DESC LIMIT 10").bind(projectId).all<{
        id: string;
        candidates_json: string;
        response_json: string | null;
        chosen: string | null;
        error: string | null;
        at: string;
      }>()).results
    : [];
  const merges = project
    ? (await env.DB.prepare("SELECT id, task_id, decision_id, mode, main_before, main_after, conflict, resolved_by, approved_by, at FROM merges WHERE project = ? ORDER BY at DESC LIMIT 30").bind(projectId).all()).results
    : [];

  const inFlight = tasks.filter((t) => IN_FLIGHT.has(t.status));
  const edges: Edge[] = [];
  if (inFlight.length > 1) {
    let vectors = new Map<string, number[]>();
    try {
      vectors = await getVectors(env, inFlight.map((t) => taskVectorId(t.id)));
    } catch (e) {
      console.warn("edge vectors failed", String(e));
    }
    const files = (t: TaskRow) => (t.files_json ? (JSON.parse(t.files_json) as string[]) : []);
    for (let i = 0; i < inFlight.length; i++) {
      for (let j = i + 1; j < inFlight.length; j++) {
        const a = vectors.get(taskVectorId(inFlight[i].id));
        const b = vectors.get(taskVectorId(inFlight[j].id));
        const c = a && b ? cosine(a, b) : 0;
        const p = jaccard(files(inFlight[i]), files(inFlight[j]));
        if (c >= 0.5 || p > 0) edges.push({ a: inFlight[i].id, b: inFlight[j].id, cosine: Number(c.toFixed(3)), paths: Number(p.toFixed(3)) });
      }
    }
  }

  return {
    project: project
      ? { id: project.id, repo: project.repo, remote: project.remote, defaultBranch: project.default_branch, head: project.head_sha, hasMap: project.basis_json !== null }
      : null,
    config: { clef: config.clef, agents: { model: config.agents.model, maxMinutes: config.agents.maxMinutes } },
    snapshot: (await getSetting(env.DB, SNAPSHOT_SETTING)) !== null,
    bootstrapStatus: await getSetting(env.DB, "bootstrap_status"),
    tasks: tasks.map((t) => ({
      id: t.id,
      goal: t.goal,
      status: t.status,
      fork: t.fork,
      baseSha: t.base_sha,
      headSha: t.head_sha,
      files: t.files_json ? (JSON.parse(t.files_json) as string[]) : [],
      diffstat: t.diffstat,
      commits: t.commits_json ? (JSON.parse(t.commits_json) as string[]) : [],
      testsOk: t.tests_ok === null ? null : t.tests_ok === 1,
      summary: t.summary ? t.summary.slice(0, 1200) : null,
      error: t.error,
      costUsd: t.cost_usd,
      restarts: t.restarts,
      resolved: t.resolved === 1,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
    positions: positions.map((p) => ({ ...p, meta: p.meta_json ? JSON.parse(p.meta_json) : null, meta_json: undefined })),
    edges,
    decisions: decisions.map((d) => {
      const candidates = JSON.parse(d.candidates_json) as { id: string }[];
      const parsed = parseMergeDecision(d.response_json ? JSON.parse(d.response_json) : null, candidates.map((c) => c.id));
      return { id: d.id, at: d.at, chosen: d.chosen, error: d.error, candidates: candidates.map((c) => c.id), next: parsed.nextProbabilities, unattended: parsed.unattended, risk: parsed.risk };
    }),
    merges,
  };
}
