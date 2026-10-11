import config from "../../lockkeeper.config";
import { deleteRepo, forkForTask, grantRepoToken, headSha } from "./artifacts";
import { getProject, getTask, listTasks, newId, recordStatus, type TaskRow, updateTask } from "./db";
import type { LockkeeperEnv } from "./env";
import { projectPosition } from "./repomap";
import { embed, nearest, taskText, taskVectorId, upsertVectors } from "./vectors";

export function projectConfig(id: string) {
  const p = config.projects.find((x) => x.id === id);
  if (!p) throw new Error(`unknown project ${id}`);
  return p;
}

const IN_FLIGHT = ["running", "ready", "merging", "needs_review", "approved"] as const;

/** What a new agent is told about the work around it. Fresh facts come from D1; similarity from the index. */
export async function buildBrief(env: LockkeeperEnv, project: string, goal: string, goalVector: number[], excludeId: string): Promise<string> {
  const inFlight = (await listTasks(env.DB, project, [...IN_FLIGHT])).filter((t) => t.id !== excludeId);
  const lines: string[] = [];
  let neighbours: { id: string; score: number; metadata: { task?: string; status?: string; paths?: string; label: string } }[] = [];
  try {
    neighbours = await nearest(env, goalVector, { project, kind: "task" }, 8);
  } catch (e) {
    console.warn("index query failed", String(e));
  }
  const similarity = new Map(neighbours.map((n) => [n.metadata.task ?? "", n.score]));
  for (const t of inFlight) {
    const files = t.files_json ? (JSON.parse(t.files_json) as string[]) : [];
    const sim = similarity.get(t.id);
    lines.push(
      `- ${t.id} (${t.status}): ${t.goal.slice(0, 200)}${files.length ? ` — touching ${files.slice(0, 8).join(", ")}` : ""}${sim !== undefined ? ` (similarity ${sim.toFixed(2)})` : ""}`,
    );
  }
  const merged = neighbours.filter((n) => n.metadata.status === "merged").slice(0, 3);
  const mergedLines = merged.map((n) => `- ${n.metadata.label}${n.metadata.paths ? ` — ${n.metadata.paths}` : ""} (similarity ${n.score.toFixed(2)})`);
  const parts: string[] = [];
  if (lines.length) parts.push(`In flight:\n${lines.join("\n")}`);
  if (mergedLines.length) parts.push(`Recently merged near your goal:\n${mergedLines.join("\n")}`);
  return parts.join("\n\n");
}

/** Create one task per goal: fork, token, brief, vector, sandbox. */
export async function createTasks(env: LockkeeperEnv, ctx: { waitUntil(promise: Promise<unknown>): void }, projectId: string, goals: string[], opts: { hold?: boolean } = {}): Promise<TaskRow[]> {
  const pc = projectConfig(projectId);
  const project = await getProject(env.DB, projectId);
  if (!project) throw new Error(`project ${projectId} is not registered; POST /api/projects/${projectId}/register first`);
  const created: TaskRow[] = [];
  const vectors = await embed(env, goals);
  for (let i = 0; i < goals.length; i++) {
    const goal = goals[i].trim();
    if (!goal) continue;
    const id = newId("t");
    const brief = await buildBrief(env, projectId, goal, vectors[i], id);
    await env.DB.prepare(
      `INSERT INTO tasks (id, project, goal, brief, status, base_sha, hold) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    )
      .bind(id, projectId, goal, brief, project.head_sha, opts.hold ? 1 : 0)
      .run();
    await recordStatus(env.DB, id, "queued");
    await indexTask(env, projectId, { id, goal, status: "queued" }, vectors[i]);
    const row = (await getTask(env.DB, id))!;
    created.push(row);
    ctx.waitUntil(startTask(env, row, brief).catch(async (e) => {
      console.error("task start failed", id, String(e));
      await updateTask(env.DB, id, { status: "failed", error: `start failed: ${String(e).slice(0, 1000)}` });
    }));
  }
  return created;
}

export async function startTask(env: LockkeeperEnv, task: TaskRow, brief: string): Promise<void> {
  const pc = projectConfig(task.project);
  const project = (await getProject(env.DB, task.project))!;
  const fork = await forkForTask(env, project.repo, task.id);
  const sandbox = `agent-${task.id}`;
  await grantRepoToken(env, sandbox, fork.name, "write", 3600);
  await updateTask(env.DB, task.id, { fork: fork.name, fork_remote: fork.remote, status: "running" });
  const stub = env.SANDBOX.getByName(sandbox);
  const { baseSha } = await stub.runTask({
    taskId: task.id,
    project: task.project,
    forkRepo: fork.name,
    forkRemote: fork.remote,
    goal: task.goal,
    brief,
    conventionsPath: pc.conventions,
    testCommand: pc.test,
    model: config.agents.model,
    maxMinutes: config.agents.maxMinutes,
    gateway: { accountId: env.AI_GATEWAY_ACCOUNT_ID, gatewayId: env.AI_GATEWAY_ID },
  });
  await updateTask(env.DB, task.id, { base_sha: baseSha });
  await indexTask(env, task.project, { id: task.id, goal: task.goal, status: "running" });
}

/** A task whose change a human pushes to the fork. Returns a one-hour write token for that person. */
export async function createManualTask(env: LockkeeperEnv, projectId: string, goal: string): Promise<{ task: TaskRow; remote: string; token: string; expiresAt: string }> {
  const project = await getProject(env.DB, projectId);
  if (!project) throw new Error(`project ${projectId} is not registered`);
  const id = newId("t");
  const fork = await forkForTask(env, project.repo, id);
  await env.DB.prepare(
    `INSERT INTO tasks (id, project, goal, brief, fork, fork_remote, status, base_sha, summary) VALUES (?, ?, ?, '', ?, ?, 'running', ?, 'manual task: a human is pushing the change')`,
  )
    .bind(id, projectId, goal, fork.name, fork.remote, project.head_sha)
    .run();
  await recordStatus(env.DB, id, "running");
  await indexTask(env, projectId, { id, goal, status: "running" });
  const repo = await env.ARTIFACTS.get(fork.name);
  const token = await repo.createToken("write", 3600);
  return { task: (await getTask(env.DB, id))!, remote: fork.remote, token: token.plaintext, expiresAt: token.expiresAt };
}

/** The human is done pushing: harvest the fork in a sandbox and let the change enter the merge round. */
export async function submitManualTask(env: LockkeeperEnv, task: TaskRow): Promise<void> {
  const pc = projectConfig(task.project);
  if (!task.fork || !task.fork_remote) throw new Error("task has no fork");
  const sandbox = `agent-${task.id}`;
  await grantRepoToken(env, sandbox, task.fork, "write", 1800);
  const base = task.base_sha ?? (await headSha(env, (await getProject(env.DB, task.project))!.repo, "main"));
  await env.SANDBOX.getByName(sandbox).harvest({
    taskId: task.id,
    project: task.project,
    forkRepo: task.fork,
    forkRemote: task.fork_remote,
    goal: task.goal,
    brief: "",
    conventionsPath: pc.conventions,
    testCommand: pc.test,
    model: config.agents.model,
    maxMinutes: config.agents.maxMinutes,
    gateway: { accountId: env.AI_GATEWAY_ACCOUNT_ID, gatewayId: env.AI_GATEWAY_ID },
    baseSha: base ?? "",
    summary: "manual task: change pushed by a human",
  });
}

export interface FinishReport {
  taskId: string;
  ok: boolean;
  error?: string;
  headSha?: string;
  files?: string[];
  diffstat?: string;
  diff?: string;
  commits?: string[];
  testsOk?: boolean;
  testOutput?: string;
  summary?: string;
  costUsd?: number;
  eventsTail?: string;
}

/** The sandbox reports here when the agent is done. Updates the ledger and the index, then asks for a merge round. */
export async function finishTask(env: LockkeeperEnv, r: FinishReport): Promise<void> {
  const task = await getTask(env.DB, r.taskId);
  if (!task) return;
  if (!r.ok) {
    await updateTask(env.DB, r.taskId, {
      status: "failed",
      error: r.error ?? "failed",
      events_tail: r.eventsTail ?? null,
      cost_usd: r.costUsd ?? null,
      summary: r.summary ?? null,
    });
    await indexTask(env, task.project, { id: task.id, goal: task.goal, status: "failed" });
    return;
  }
  await updateTask(env.DB, r.taskId, {
    status: "ready",
    head_sha: r.headSha ?? null,
    files_json: JSON.stringify(r.files ?? []),
    diffstat: r.diffstat ?? null,
    diff: r.diff ?? null,
    commits_json: JSON.stringify(r.commits ?? []),
    tests_ok: r.testsOk ? 1 : 0,
    summary: [r.summary ?? "", r.testsOk ? "" : `\n\nTests failed:\n${r.testOutput ?? ""}`].join("").trim() || null,
    cost_usd: r.costUsd ?? null,
    events_tail: r.eventsTail ?? null,
  });
  await indexTask(env, task.project, {
    id: task.id,
    goal: task.goal,
    status: "ready",
    files: r.files,
    diffstat: r.diffstat,
    commits: r.commits,
    summary: r.summary,
  });
  await triggerMerge(env, task.project);
}

/** Embed a task's current description, upsert it into the index and place it on the map. */
export async function indexTask(
  env: LockkeeperEnv,
  project: string,
  t: { id: string; goal: string; status: string; files?: string[]; diffstat?: string | null; commits?: string[]; summary?: string | null },
  precomputed?: number[],
): Promise<void> {
  try {
    const values = precomputed ?? (await embed(env, [taskText(t)]))[0];
    await upsertVectors(env, [
      {
        id: taskVectorId(t.id),
        values,
        metadata: {
          kind: "task",
          project,
          task: t.id,
          status: t.status,
          paths: (t.files ?? []).slice(0, 40).join(","),
          label: t.goal.slice(0, 200),
        },
      },
    ]);
    await projectPosition(env, project, { id: taskVectorId(t.id), kind: "task", label: t.goal.slice(0, 120), values, meta: { task: t.id, status: t.status } });
  } catch (e) {
    console.warn("indexTask failed", t.id, String(e));
  }
}

export async function triggerMerge(env: LockkeeperEnv, project: string): Promise<void> {
  try {
    await env.MERGE_WORKFLOW.create({ id: `merge-${project}-${Date.now()}`, params: { project } });
  } catch (e) {
    console.error("could not start merge workflow", String(e));
  }
}

/** Every commit that landed with a merge becomes a point on the map and a vector in the index. */
export async function indexCommits(env: LockkeeperEnv, task: TaskRow, mainBefore: string | null, mainAfter: string): Promise<void> {
  const project = await getProject(env.DB, task.project);
  if (!project) return;
  const repo = await env.ARTIFACTS.get(project.repo);
  const log = await repo.log({ ref: mainAfter, limit: 60 });
  const landed: typeof log = [];
  for (const c of log) {
    if (mainBefore && c.hash === mainBefore) break;
    landed.push(c);
  }
  if (landed.length === 0) return;
  const files = task.files_json ? (JSON.parse(task.files_json) as string[]) : [];
  const texts = landed.map((c) => `Commit: ${c.message.split("\n")[0].slice(0, 200)}\nFiles: ${files.join(", ")}\nGoal: ${task.goal}`);
  const vectors = await embed(env, texts);
  await upsertVectors(
    env,
    landed.map((c, i) => ({
      id: `commit:${task.project}:${c.hash}`,
      values: vectors[i],
      metadata: { kind: "commit" as const, project: task.project, task: task.id, status: "merged", paths: files.slice(0, 40).join(","), label: c.message.split("\n")[0].slice(0, 200) },
    })),
  );
  for (let i = 0; i < landed.length; i++) {
    const c = landed[i];
    await projectPosition(env, task.project, {
      id: `commit:${task.project}:${c.hash}`,
      kind: "commit",
      label: c.message.split("\n")[0].slice(0, 120),
      values: vectors[i],
      meta: { task: task.id, sha: c.hash, merge: i === 0, author: c.author?.name ?? null, files: files.slice(0, 12) },
    });
  }
}

export async function markMerged(env: LockkeeperEnv, task: TaskRow, mainAfter: string, mainBefore: string | null = null): Promise<void> {
  await updateTask(env.DB, task.id, { status: "merged" });
  void mainBefore; // commits are placed by indexProject, which follows every merge
  await indexTask(env, task.project, {
    id: task.id,
    goal: task.goal,
    status: "merged",
    files: task.files_json ? (JSON.parse(task.files_json) as string[]) : [],
    diffstat: task.diffstat,
    commits: task.commits_json ? (JSON.parse(task.commits_json) as string[]) : [],
    summary: task.summary,
  });
  await env.DB.prepare("UPDATE projects SET head_sha = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(mainAfter, task.project).run();
  if (task.fork) {
    try {
      await deleteRepo(env, task.fork);
    } catch (e) {
      console.warn("fork delete failed", task.fork, String(e));
    }
  }
  await env.DB.prepare("DELETE FROM tokens WHERE sandbox = ?").bind(`agent-${task.id}`).run();
}

/** A blocked task restarts once from a fresh fork of the new main, with a brief that says what merged. */
export async function restartTask(env: LockkeeperEnv, task: TaskRow): Promise<boolean> {
  if (task.restarts >= 1) return false;
  const project = (await getProject(env.DB, task.project))!;
  if (task.fork) await deleteRepo(env, task.fork).catch(() => undefined);
  const head = await headSha(env, project.repo, "main");
  const vectors = await embed(env, [task.goal]);
  const brief = await buildBrief(env, task.project, task.goal, vectors[0], task.id);
  const fullBrief = `${brief}\n\nYour earlier attempt conflicted with work that merged meanwhile; start again from the current main.`;
  await updateTask(env.DB, task.id, {
    status: "queued",
    restarts: task.restarts + 1,
    brief: fullBrief,
    base_sha: head,
    head_sha: null,
    files_json: null,
    diffstat: null,
    diff: null,
    commits_json: null,
    tests_ok: null,
    error: null,
    resolved: 0,
  });
  const fresh = (await getTask(env.DB, task.id))!;
  await startTask(env, fresh, fullBrief);
  return true;
}
