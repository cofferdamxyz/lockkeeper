import { Hono } from "hono";

import config from "../../lockkeeper.config";
import { deleteRepo } from "./artifacts";
import { getProject, getSetting, getTask, listTasks, setSetting, updateTask, upsertProject } from "./db";
import type { LockkeeperEnv } from "./env";
import { handleQueue } from "./queue";
import { indexProject } from "./repomap";
import { SNAPSHOT_SETTING } from "./sandbox";
import { getState } from "./state";
import { createTasks, projectConfig, restartTask, triggerMerge } from "./tasks";

export { AgentSandbox } from "./sandbox";
export { MergeWorkflow } from "./workflow";
export { Outbound } from "./outbound";

type Bindings = { Bindings: LockkeeperEnv };

const app = new Hono<Bindings>();

app.get("/health", (c) => c.json({ ok: true, projects: config.projects.map((p) => p.id) }));

// Bearer token for everything under /api. Access replaces this for an organisation's deployment.
app.use("/api/*", async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : c.req.query("token") ?? "";
  if (!c.env.DASHBOARD_TOKEN || token !== c.env.DASHBOARD_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
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
app.get("/api/state", async (c) => c.json(await getState(c.env, c.req.query("project") ?? config.projects[0].id)));

app.post("/api/tasks", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { project?: string; goals?: string[] | string; goal?: string };
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
  const tasks = await createTasks(c.env, c.executionCtx, projectId, clean);
  return c.json({ tasks: tasks.map((t) => ({ id: t.id, goal: t.goal, status: t.status })) }, 202);
});

app.get("/api/tasks/:id", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json({ error: "not found" }, 404);
  return c.json(task);
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
  await updateTask(c.env.DB, task.id, { status: "abandoned" });
  c.executionCtx.waitUntil(
    (async () => {
      await c.env.SANDBOX.getByName(`agent-${task.id}`).destroy().catch(() => undefined);
      if (task.fork) await deleteRepo(c.env, task.fork).catch(() => undefined);
      await c.env.DB.prepare("DELETE FROM tokens WHERE sandbox = ?").bind(`agent-${task.id}`).run();
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

export default {
  fetch: app.fetch,
  queue: handleQueue,
} satisfies ExportedHandler<LockkeeperEnv>;
