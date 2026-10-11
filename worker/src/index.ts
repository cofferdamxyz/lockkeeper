import { Hono } from "hono";

import { parseActivity } from "./activity";

import config from "../../lockkeeper.config";
import { deleteRepo } from "./artifacts";
import { getProject, getSetting, getTask, listTasks, setSetting, updateTask, upsertProject } from "./db";
import type { LockkeeperEnv } from "./env";
import { commitDetail, deleteLiveCommits, fileDetail } from "./history";
import { notify } from "./live";
import { handleQueue } from "./queue";
import { indexProject } from "./repomap";
import { SNAPSHOT_SETTING } from "./sandbox";
import { getState } from "./state";
import { createManualTask, createTasks, projectConfig, restartTask, submitManualTask, triggerMerge } from "./tasks";

export { LiveHub } from "./live";
export { AgentSandbox } from "./sandbox";
export { MergeWorkflow } from "./workflow";
export { Outbound } from "./outbound";

type Bindings = { Bindings: LockkeeperEnv };

const app = new Hono<Bindings>();

app.onError((err, c) => {
  console.error("request failed", c.req.method, c.req.path, err instanceof Error ? err.stack : String(err));
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

app.get("/health", (c) => c.json({ ok: true, projects: config.projects.map((p) => p.id) }));

/**
 * Live updates. A WebSocket cannot carry the bearer header, so the dashboard asks for a
 * single-use ticket (below, authenticated) and connects here with it; the hub checks it.
 */
app.get("/api/live", async (c) => {
  const project = c.req.query("project") ?? config.projects[0].id;
  const ticket = c.req.query("ticket") ?? "";
  if (!c.env.LIVE) return c.json({ error: "live hub is not deployed" }, 503);
  if (!ticket) return c.json({ error: "ticket required" }, 401);
  const stub = c.env.LIVE.getByName(`live-${project}`);
  return stub.fetch(new Request(`https://live/connect?ticket=${encodeURIComponent(ticket)}`, c.req.raw));
});

// Bearer token for everything under /api. Access replaces this for an organisation's deployment.
app.use("/api/*", async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : c.req.query("token") ?? "";
  if (!c.env.DASHBOARD_TOKEN || token !== c.env.DASHBOARD_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.post("/api/live/ticket", async (c) => {
  const project = c.req.query("project") ?? config.projects[0].id;
  if (!c.env.LIVE) return c.json({ error: "live hub is not deployed" }, 503);
  const ticket = await c.env.LIVE.getByName(`live-${project}`).ticket();
  return c.json({ ticket, path: `/api/live?project=${encodeURIComponent(project)}&ticket=${encodeURIComponent(ticket)}` });
});

/**
 * Pin the order in which ready changes enter the lock. Clef still scores each change and the
 * unattended rule still applies; only the choice of what goes first is overridden.
 */
app.put("/api/projects/:id/lock", async (c) => {
  const pc = projectConfig(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { order?: string[] };
  const order = Array.isArray(body.order) ? body.order.filter((x) => typeof x === "string").slice(0, 50) : [];
  await c.env.DB.prepare("UPDATE tasks SET lock_order = NULL WHERE project = ?").bind(pc.id).run();
  for (let i = 0; i < order.length; i++) {
    await c.env.DB.prepare("UPDATE tasks SET lock_order = ? WHERE id = ? AND project = ?").bind(i + 1, order[i], pc.id).run();
  }
  await notify(c.env, pc.id, { type: "lock" });
  return c.json({ project: pc.id, order });
});

app.get("/api/projects", async (c) => {
  const rows = await Promise.all(
    config.projects.map(async (p) => {
      const row = await getProject(c.env.DB, p.id);
      return { ...p, registered: row !== null, remote: row?.remote ?? null, head: row?.head_sha ?? null, hasMap: row?.basis_json != null };
    }),
  );
  return c.json({ projects: rows, snapshot: (await getSetting(c.env.DB, SNAPSHOT_SETTING)) !== null, bootstrapStatus: await getSetting(c.env.DB, "bootstrap_status") });
});

/** Create the Artifacts repository for a configured project (if missing) and record it. */
app.post("/api/projects/:id/register", async (c) => {
  const pc = projectConfig(c.req.param("id"));
  let remote: string;
  try {
    const created = await c.env.ARTIFACTS.create(pc.repo, { description: `Lockkeeper project ${pc.id}`, setDefaultBranch: pc.defaultBranch });
    remote = created.remote;
  } catch (e) {
    // Already exists: read it back.
    const repo = await c.env.ARTIFACTS.get(pc.repo);
    const info = await repo.info();
    remote = (info as unknown as { remote?: string }).remote ?? `https://${c.env.AI_GATEWAY_ACCOUNT_ID}.artifacts.cloudflare.net/git/${c.env.ARTIFACTS_NAMESPACE}/${pc.repo}.git`;
    console.log("register: repository exists", pc.repo, String(e).slice(0, 200));
  }
  await upsertProject(c.env.DB, { id: pc.id, repo: pc.repo, remote, default_branch: pc.defaultBranch });
  return c.json({ id: pc.id, repo: pc.repo, remote });
});

/** A short-lived token for a human to push or clone the project repository from their machine. */
app.post("/api/projects/:id/token", async (c) => {
  const pc = projectConfig(c.req.param("id"));
  const scope = (c.req.query("scope") === "read" ? "read" : "write") as "read" | "write";
  const repo = await c.env.ARTIFACTS.get(pc.repo);
  const token = await repo.createToken(scope, 600);
  const project = await getProject(c.env.DB, pc.id);
  return c.json({ remote: project?.remote, scope, token: token.plaintext, expiresAt: token.expiresAt });
});

app.post("/api/projects/:id/index", async (c) => {
  const pc = projectConfig(c.req.param("id"));
  const result = await indexProject(c.env, pc.id, { refit: c.req.query("refit") === "1" });
  return c.json(result);
});

app.get("/api/projects/:id/state", async (c) => c.json(await getState(c.env, c.req.param("id"))));

/** One commit: message, author, date, parents, the files it changed, the task that produced it. */
app.get("/api/projects/:id/commits/:sha", async (c) => {
  const pc = projectConfig(c.req.param("id"));
  const sha = c.req.param("sha");
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return c.json({ error: "bad sha" }, 400);
  const d = await commitDetail(c.env, pc.id, sha);
  return d ? c.json(d) : c.json({ error: "not found" }, 404);
});

/** One file on the default branch, with the commits that touched it. */
app.get("/api/projects/:id/file", async (c) => {
  const pc = projectConfig(c.req.param("id"));
  const path = c.req.query("path") ?? "";
  if (!path || path.includes("..")) return c.json({ error: "path is required" }, 400);
  const d = await fileDetail(c.env, pc.id, path);
  return d ? c.json(d) : c.json({ error: "not found" }, 404);
});
app.get("/api/state", async (c) => c.json(await getState(c.env, c.req.query("project") ?? config.projects[0].id)));

app.post("/api/tasks", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { project?: string; goals?: string[] | string; goal?: string; mode?: "auto" | "review" };
  const projectId = body.project ?? config.projects[0].id;
  const goals = Array.isArray(body.goals)
    ? body.goals
    : typeof body.goals === "string"
      ? body.goals.split("\n")
      : body.goal
        ? [body.goal]
        : [];
  const clean = goals.map((g) => g.trim()).filter(Boolean);
  if (clean.length === 0) return c.json({ error: "no goals" }, 400);
  if (clean.length > 12) return c.json({ error: "at most 12 goals per launch" }, 400);
  if ((await getSetting(c.env.DB, SNAPSHOT_SETTING)) === null) return c.json({ error: "no agent snapshot yet; POST /api/admin/bootstrap first" }, 409);
  const tasks = await createTasks(c.env, c.executionCtx, projectId, clean, { hold: body.mode === "review" });
  return c.json({ tasks: tasks.map((t) => ({ id: t.id, goal: t.goal, status: t.status })) }, 202);
});

/** A task a human works on: returns the fork remote and a one-hour write token. */
app.post("/api/tasks/manual", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { project?: string; goal?: string };
  if (!body.goal?.trim()) return c.json({ error: "goal is required" }, 400);
  const result = await createManualTask(c.env, body.project ?? config.projects[0].id, body.goal.trim());
  return c.json({ id: result.task.id, remote: result.remote, token: result.token, expiresAt: result.expiresAt }, 201);
});

/** The human has pushed; harvest the fork and enter the merge round. */
app.post("/api/tasks/:id/submit", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json({ error: "not found" }, 404);
  if (task.status !== "running") return c.json({ error: `task is ${task.status}` }, 409);
  c.executionCtx.waitUntil(
    submitManualTask(c.env, task).catch(async (e) => {
      await updateTask(c.env.DB, task.id, { status: "failed", error: `submit failed: ${String(e).slice(0, 1000)}` });
    }),
  );
  return c.json({ id: task.id, status: "harvesting" }, 202);
});

app.get("/api/tasks/:id", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json({ error: "not found" }, 404);
  return c.json(task);
});

/** The agent's stream parsed into reads, edits, commands, notes and the outcome. */
app.get("/api/tasks/:id/events", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json({ error: "not found" }, 404);
  let raw = task.events_tail ?? "";
  if (task.status === "running") {
    const live = await c.env.SANDBOX.getByName(`agent-${task.id}`).readTail(200).catch(() => "");
    if (live) raw = live;
  }
  return c.json({ id: task.id, status: task.status, events: parseActivity(raw) });
});

/** Everything with a timestamp, oldest first: status changes, decisions, merges, pushes. */
app.get("/api/history", async (c) => {
  const project = c.req.query("project") ?? config.projects[0].id;
  const statuses = await c.env.DB.prepare(
    `SELECT e.at AS at, json_extract(e.payload_json, '$.task') AS task, json_extract(e.payload_json, '$.status') AS status
     FROM events e JOIN tasks t ON t.id = json_extract(e.payload_json, '$.task')
     WHERE e.type = 'task.status' AND t.project = ? ORDER BY e.id`,
  )
    .bind(project)
    .all<{ at: string; task: string; status: string }>();
  const decisions = await c.env.DB.prepare("SELECT id, at, chosen, candidates_json FROM decisions WHERE project = ? ORDER BY at").bind(project).all<{ id: string; at: string; chosen: string | null; candidates_json: string }>();
  const merges = await c.env.DB.prepare("SELECT id, at, task_id, mode, main_after, conflict, resolved_by FROM merges WHERE project = ? ORDER BY at").bind(project).all<{ id: number; at: string; task_id: string; mode: string; main_after: string | null; conflict: number; resolved_by: string | null }>();
  const pushes = await c.env.DB.prepare("SELECT at, ref, after_sha FROM pushes WHERE project = ? ORDER BY at").bind(project).all<{ at: string; ref: string; after_sha: string | null }>();
  const items = [
    ...statuses.results.map((s) => ({ at: s.at, kind: "status" as const, task: s.task, status: s.status })),
    ...decisions.results.map((d) => ({ at: d.at, kind: "decision" as const, id: d.id, chosen: d.chosen, candidates: (JSON.parse(d.candidates_json) as { id: string }[]).map((x) => x.id) })),
    ...merges.results.map((m) => ({ at: m.at, kind: "merge" as const, task: m.task_id, mode: m.mode, mainAfter: m.main_after, conflict: m.conflict === 1, resolvedBy: m.resolved_by })),
    ...pushes.results.map((p) => ({ at: p.at, kind: "push" as const, ref: p.ref, sha: p.after_sha })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return c.json({ project, items });
});

app.get("/api/tasks/:id/tail", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json({ error: "not found" }, 404);
  if (task.status === "running") {
    const tail = await c.env.SANDBOX.getByName(`agent-${task.id}`).readTail(80);
    return c.text(tail || task.events_tail || "");
  }
  return c.text(task.events_tail ?? "");
});

app.post("/api/tasks/:id/approve", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json({ error: "not found" }, 404);
  if (task.status !== "needs_review") return c.json({ error: `task is ${task.status}` }, 409);
  await updateTask(c.env.DB, task.id, { status: "approved", error: null });
  await notify(c.env, task.project, { type: "task", task: task.id, status: "approved" });
  await triggerMerge(c.env, task.project);
  return c.json({ id: task.id, status: "approved" });
});

app.post("/api/tasks/:id/retry", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json({ error: "not found" }, 404);
  if (!["failed", "blocked", "needs_review", "abandoned"].includes(task.status)) return c.json({ error: `task is ${task.status}` }, 409);
  await updateTask(c.env.DB, task.id, { restarts: 0 });
  const fresh = (await getTask(c.env.DB, task.id))!;
  c.executionCtx.waitUntil(
    restartTask(c.env, fresh).catch(async (e) => {
      await updateTask(c.env.DB, task.id, { status: "failed", error: `retry failed: ${String(e).slice(0, 1000)}` });
    }),
  );
  return c.json({ id: task.id, status: "queued" }, 202);
});

app.post("/api/tasks/:id/abandon", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json({ error: "not found" }, 404);
  await updateTask(c.env.DB, task.id, { status: "abandoned", lock_order: null });
  await notify(c.env, task.project, { type: "task", task: task.id, status: "abandoned" });
  c.executionCtx.waitUntil(
    (async () => {
      await c.env.SANDBOX.getByName(`agent-${task.id}`).destroy().catch(() => undefined);
      if (task.fork) await deleteRepo(c.env, task.fork).catch(() => undefined);
      await c.env.DB.prepare("DELETE FROM tokens WHERE sandbox = ?").bind(`agent-${task.id}`).run();
      await deleteLiveCommits(c.env, task.project, task.id);
    })(),
  );
  return c.json({ id: task.id, status: "abandoned" });
});

/** Build the agent base snapshot. Runs in the background; poll GET /api/admin/bootstrap. */
app.post("/api/admin/bootstrap", async (c) => {
  await setSetting(c.env.DB, "bootstrap_status", "starting");
  await c.env.SANDBOX.getByName("bootstrap").startBootstrap(c.env.CLAUDE_CODE_VERSION);
  return c.json({ status: "installing", claudeCode: c.env.CLAUDE_CODE_VERSION }, 202);
});
app.get("/api/admin/bootstrap", async (c) =>
  c.json({ status: await getSetting(c.env.DB, "bootstrap_status"), snapshot: await getSetting(c.env.DB, SNAPSHOT_SETTING) }),
);

app.get("/api/admin/tasks", async (c) => c.json(await listTasks(c.env.DB, c.req.query("project") ?? config.projects[0].id)));

/** Start a merge round now (normally triggered when a task becomes ready). */
app.post("/api/admin/merge/:project", async (c) => {
  const pc = projectConfig(c.req.param("project"));
  await triggerMerge(c.env, pc.id);
  return c.json({ project: pc.id, status: "merge round requested" }, 202);
});

/** Place the commits of every merged task on the map (backfill after upgrades). */
app.post("/api/admin/reindex-commits/:project", async (c) => {
  const pc = projectConfig(c.req.param("project"));
  const rows = await c.env.DB.prepare(
    "SELECT m.task_id, m.main_before, m.main_after FROM merges m WHERE m.project = ? AND m.main_after IS NOT NULL ORDER BY m.at",
  )
    .bind(pc.id)
    .all<{ task_id: string; main_before: string | null; main_after: string }>();
  const result = await indexProject(c.env, pc.id);
  return c.json({ project: pc.id, merges: rows.results.length, ...result });
});

/** Operator reset for a task stuck by an infrastructure failure. */
app.post("/api/admin/tasks/:id/status", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const allowed = ["ready", "needs_review", "failed", "abandoned"];
  if (!body.status || !allowed.includes(body.status)) return c.json({ error: `status must be one of ${allowed.join(", ")}` }, 400);
  await updateTask(c.env.DB, task.id, { status: body.status as "ready", error: null });
  await notify(c.env, task.project, { type: "task", task: task.id, status: body.status });
  if (body.status === "ready") await triggerMerge(c.env, task.project);
  return c.json({ id: task.id, status: body.status });
});

export default {
  fetch: app.fetch,
  queue: handleQueue,
} satisfies ExportedHandler<LockkeeperEnv>;
