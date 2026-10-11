import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import config from "../../lockkeeper.config";
import { grantRepoToken } from "./artifacts";
import { buildMergeRequest, type Candidate, type MergeDecision, parseMergeDecision, type RecentMerge, runClef } from "./clef";
import { acquireLease, getProject, getTask, listTasks, newId, releaseLease, type TaskRow, updateTask } from "./db";
import type { LockkeeperEnv } from "./env";
import { indexProject } from "./repomap";
import { markMerged, projectConfig, restartTask, triggerMerge } from "./tasks";
import { cosine, getVectors, jaccard, taskVectorId } from "./vectors";

type RoundOutcome = { kind: "idle" } | { kind: "continue" } | { kind: "resolving"; taskId: string };
type ResolveOutcome = { kind: "running" } | { kind: "done" };

/**
 * One instance per project at a time (D1 lease). Each round takes the ready set, asks Clef what
 * merges next and whether unattended, merges it in the merge sandbox, and loops until idle.
 */
export class MergeWorkflow extends WorkflowEntrypoint<LockkeeperEnv, { project: string }> {
  async run(event: WorkflowEvent<{ project: string }>, step: WorkflowStep): Promise<unknown> {
    const project = event.payload.project;
    const instance = event.instanceId;
    const leased = await step.do("lease", () => acquireLease(this.env.DB, project, instance));
    if (!leased) return { skipped: "another merge instance holds the lease" };
    const rounds: RoundOutcome[] = [];
    try {
      for (let round = 0; round < 40; round++) {
        const outcome = await step.do(`round ${round}`, { retries: { limit: 0, delay: "1 second" } }, () => mergeRound(this.env, project));
        rounds.push(outcome);
        if (outcome.kind === "idle") break;
        if (outcome.kind === "resolving") {
          let status: ResolveOutcome = { kind: "running" };
          for (let i = 0; i < 60 && status.kind === "running"; i++) {
            await step.sleep(`resolve wait ${round}.${i}`, "20 seconds");
            status = await step.do(`resolve poll ${round}.${i}`, { retries: { limit: 0, delay: "1 second" } }, () => pollResolve(this.env, project, outcome.taskId));
          }
          if (status.kind === "running") {
            await step.do(`resolve give up ${round}`, () => giveUpResolve(this.env, project, outcome.taskId));
          }
        }
      }
    } finally {
      await step.do("release", () => releaseLease(this.env.DB, project, instance));
      // A task that became ready while this instance was finishing may have found the lease taken.
      await step.do("recheck", async () => {
        const pending = await listTasks(this.env.DB, project, ["ready", "approved"]);
        if (pending.length > 0) await triggerMerge(this.env, project);
        return pending.length;
      });
    }
    return { rounds: rounds.length };
  }
}

async function recentMerges(env: LockkeeperEnv, project: string): Promise<RecentMerge[]> {
  const r = await env.DB.prepare(
    "SELECT id, goal, files_json, updated_at FROM tasks WHERE project = ? AND status = 'merged' ORDER BY updated_at DESC LIMIT 5",
  )
    .bind(project)
    .all<{ id: string; goal: string; files_json: string | null; updated_at: string }>();
  return r.results.map((t) => ({ id: t.id, goal: t.goal, files: t.files_json ? (JSON.parse(t.files_json) as string[]) : [], at: t.updated_at }));
}

async function buildCandidates(env: LockkeeperEnv, tasks: TaskRow[]): Promise<Candidate[]> {
  let vectors = new Map<string, number[]>();
  try {
    vectors = await getVectors(env, tasks.map((t) => taskVectorId(t.id)));
  } catch (e) {
    console.warn("vector fetch failed", String(e));
  }
  const files = new Map(tasks.map((t) => [t.id, t.files_json ? (JSON.parse(t.files_json) as string[]) : []]));
  return tasks.map((t) => ({
    id: t.id,
    goal: t.goal,
    files: files.get(t.id) ?? [],
    diffstat: t.diffstat ?? "",
    testsOk: t.tests_ok === 1,
    ageMinutes: Math.round((Date.now() - new Date(t.created_at).getTime()) / 60_000),
    commits: t.commits_json ? (JSON.parse(t.commits_json) as string[]) : [],
    resolved: t.resolved === 1,
    overlaps: tasks
      .filter((o) => o.id !== t.id)
      .map((o) => {
        const a = vectors.get(taskVectorId(t.id));
        const b = vectors.get(taskVectorId(o.id));
        return {
          with: o.id,
          cosine: a && b ? Number(cosine(a, b).toFixed(3)) : 0,
          paths: Number(jaccard(files.get(t.id) ?? [], files.get(o.id) ?? []).toFixed(3)),
        };
      }),
  }));
}

function mergeMessage(task: TaskRow, decisionId: string | null): string {
  const commits = task.commits_json ? (JSON.parse(task.commits_json) as string[]) : [];
  return [
    `Merge task ${task.id}: ${task.goal.split("\n")[0].slice(0, 72)}`,
    "",
    task.goal,
    "",
    commits.length ? `Commits:\n${commits.map((c) => `- ${c}`).join("\n")}` : "",
    "",
    `Lockkeeper-Task: ${task.id}`,
    `Lockkeeper-Decision: ${decisionId ?? "approved"}`,
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export async function mergeRound(env: LockkeeperEnv, project: string): Promise<RoundOutcome> {
  const pc = projectConfig(project);
  const projectRow = await getProject(env.DB, project);
  if (!projectRow?.remote) throw new Error(`project ${project} has no remote`);
  const approved = await listTasks(env.DB, project, ["approved"]);
  const ready = await listTasks(env.DB, project, ["ready"]);
  if (approved.length === 0 && ready.length === 0) return { kind: "idle" };

  let chosen: TaskRow;
  let decisionId: string | null = null;
  let unattendedOk = false;
  let decision: MergeDecision | null = null;
  if (approved.length > 0) {
    chosen = approved[0];
    unattendedOk = true;
  } else {
    const slice = ready.slice(0, config.clef.maxCandidates);
    const candidates = await buildCandidates(env, slice);
    const recent = await recentMerges(env, project);
    const request = buildMergeRequest(candidates, recent, config.clef.model);
    decisionId = newId("d");
    let raw: unknown = null;
    let error: string | null = null;
    try {
      raw = await runClef(env, request);
    } catch (e) {
      error = String(e).slice(0, 2000);
      console.error("clef failed", error);
    }
    decision = parseMergeDecision(raw, candidates.map((c) => c.id));
    const nextId = decision.next ?? slice[0].id;
    await env.DB.prepare(
      "INSERT INTO decisions (id, project, candidates_json, request_json, response_json, chosen, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(decisionId, project, JSON.stringify(candidates), JSON.stringify(request), raw === null ? null : JSON.stringify(raw), nextId, error)
      .run();
    chosen = slice.find((t) => t.id === nextId) ?? slice[0];
    const p = decision.unattended[chosen.id];
    const risk = decision.risk[chosen.id];
    const threshold = chosen.resolved === 1 ? config.clef.unattendedAfterResolve : config.clef.unattended;
    unattendedOk = chosen.hold !== 1 && Number.isFinite(p) && p >= threshold && Number.isFinite(risk) && risk <= config.clef.maxRisk && chosen.tests_ok === 1;
  }

  await updateTask(env.DB, chosen.id, { status: "merging" });
  const sandboxName = `merge-${project}`;
  const stub = env.SANDBOX.getByName(sandboxName);
  await grantRepoToken(env, sandboxName, projectRow.repo, "write", 900);
  if (chosen.fork) await grantRepoToken(env, sandboxName, chosen.fork, "write", 900);
  let attempt: Awaited<ReturnType<typeof stub.mergeTask>>;
  try {
    await stub.ensureProjectClone({ project, remote: projectRow.remote });
    attempt = await stub.mergeTask({
      taskId: chosen.id,
      forkRemote: chosen.fork_remote!,
      testCommand: pc.test,
      message: mergeMessage(chosen, decisionId),
    });
  } catch (e) {
    // The merge sandbox could not even attempt the merge; hold the change rather than lose it.
    const why = String(e).slice(0, 1500);
    console.error("merge attempt failed", chosen.id, why);
    await stub.abortMerge().catch(() => undefined);
    await updateTask(env.DB, chosen.id, { status: "needs_review", error: `merge attempt failed: ${why}` });
    await env.DB.prepare(
      "INSERT INTO merges (task_id, project, decision_id, mode, conflict, output) VALUES (?, ?, ?, 'error', 0, ?)",
    )
      .bind(chosen.id, project, decisionId, why)
      .run();
    return { kind: "continue" };
  }

  if (attempt.conflict) {
    const mergedGoals = (await recentMerges(env, project)).map((m) => m.goal);
    await env.DB.prepare(
      "INSERT INTO merges (task_id, project, decision_id, mode, main_before, conflict, output) VALUES (?, ?, ?, 'conflict', ?, 1, ?)",
    )
      .bind(chosen.id, project, decisionId, attempt.mainBefore, `conflicted: ${attempt.conflictedFiles.join(", ")}`)
      .run();
    await stub.startResolve({
      taskId: chosen.id,
      project,
      candidateGoal: chosen.goal,
      mergedGoals,
      conflictedFiles: attempt.conflictedFiles,
      testCommand: pc.test,
      model: config.agents.model,
      maxMinutes: 15,
      gateway: { accountId: env.AI_GATEWAY_ACCOUNT_ID, gatewayId: env.AI_GATEWAY_ID },
    });
    return { kind: "resolving", taskId: chosen.id };
  }

  if (!attempt.testsOk) {
    await stub.abortMerge();
    await updateTask(env.DB, chosen.id, { status: "needs_review", error: `tests failed after merging onto main:\n${attempt.output.slice(-2000)}` });
    await env.DB.prepare(
      "INSERT INTO merges (task_id, project, decision_id, mode, main_before, conflict, output) VALUES (?, ?, ?, 'needs_review', ?, 0, ?)",
    )
      .bind(chosen.id, project, decisionId, attempt.mainBefore, attempt.output.slice(-4000))
      .run();
    return { kind: "continue" };
  }

  if (!unattendedOk) {
    await stub.abortMerge();
    const why = chosen.hold === 1
      ? `launched in review mode${decision ? ` (Clef: unattended ${fmt(decision.unattended[chosen.id])}, risk ${fmt(decision.risk[chosen.id])})` : ""}`
      : decision
        ? `Clef: unattended ${fmt(decision.unattended[chosen.id])}, risk ${fmt(decision.risk[chosen.id])}`
        : "no decision";
    await updateTask(env.DB, chosen.id, { status: "needs_review", error: `held for review (${why})` });
    await env.DB.prepare(
      "INSERT INTO merges (task_id, project, decision_id, mode, main_before, conflict, output) VALUES (?, ?, ?, 'needs_review', ?, 0, ?)",
    )
      .bind(chosen.id, project, decisionId, attempt.mainBefore, why)
      .run();
    return { kind: "continue" };
  }

  const { mainAfter } = await stub.pushMerge();
  await env.DB.prepare(
    "INSERT INTO merges (task_id, project, decision_id, mode, main_before, main_after, conflict, resolved_by, approved_by, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      chosen.id,
      project,
      decisionId,
      approved.length > 0 ? "approved" : "unattended",
      attempt.mainBefore,
      mainAfter,
      chosen.resolved,
      chosen.resolved === 1 ? "agent" : null,
      approved.length > 0 ? "dashboard" : null,
      attempt.output.slice(-4000),
    )
    .run();
  await markMerged(env, chosen, mainAfter, attempt.mainBefore);
  try {
    await indexProject(env, project);
  } catch (e) {
    console.warn("re-index after merge failed", String(e));
  }
  return { kind: "continue" };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "n/a";
}

export async function pollResolve(env: LockkeeperEnv, project: string, taskId: string): Promise<ResolveOutcome> {
  const stub = env.SANDBOX.getByName(`merge-${project}`);
  const status = await stub.resolveStatus();
  if (status.state === "running") return { kind: "running" };
  const task = await getTask(env.DB, taskId);
  if (!task) return { kind: "done" };
  if (status.state === "succeeded" && status.testsOk) {
    await stub.pushMergeToFork({ taskId });
    await updateTask(env.DB, taskId, {
      status: "ready",
      resolved: 1,
      head_sha: status.mergeSha,
      summary: `${task.summary ?? ""}\n\nResolver: ${status.summary}`.trim(),
      error: null,
    });
    await env.DB.prepare("UPDATE merges SET resolved_by = 'agent', output = ? WHERE task_id = ? AND mode = 'conflict' AND resolved_by IS NULL")
      .bind(`resolved by agent; tests green at ${status.mergeSha}`, taskId)
      .run();
    return { kind: "done" };
  }
  const reason = status.state === "succeeded" ? "resolver finished but tests failed" : status.state === "failed" ? status.error : "no resolver run";
  await stub.abortMerge();
  await updateTask(env.DB, taskId, { status: "blocked", error: reason });
  await env.DB.prepare("UPDATE merges SET output = ? WHERE task_id = ? AND mode = 'conflict' AND resolved_by IS NULL").bind(reason, taskId).run();
  const fresh = (await getTask(env.DB, taskId))!;
  const restarted = await restartTask(env, fresh).catch((e) => {
    console.error("restart failed", String(e));
    return false;
  });
  if (!restarted) await updateTask(env.DB, taskId, { status: "blocked", error: `${reason}; no restarts left` });
  return { kind: "done" };
}

export async function giveUpResolve(env: LockkeeperEnv, project: string, taskId: string): Promise<void> {
  const stub = env.SANDBOX.getByName(`merge-${project}`);
  await stub.abortMerge();
  await updateTask(env.DB, taskId, { status: "blocked", error: "resolver did not finish in time" });
}
