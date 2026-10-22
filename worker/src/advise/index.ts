import { Hono } from "hono";

import config from "../../../lockkeeper.config";
import { AccessError, verifyAccess, type Identity } from "./access";
import { ClaimError, createClaim, dropClaim, extendClaim, listClaims, repoName } from "./claims";
import type { AdviseEnv } from "./env";
import { briefText, check, checkText, inFlight, toJson } from "./inflight";
import { handleMcp } from "./mcp";
import { cleanPaths } from "./paths";
import { poll } from "./poll";
import { getSetting } from "./store";

/**
 * Lockkeeper, the Cofferdam advisory deployment (`wrangler.cofferdam.jsonc`; DESIGN.md §12–§13,
 * workspace decision 0053). Headless: an HTTP API and an MCP server behind Cloudflare Access, and
 * a cron that polls GitHub. It imports none of the runner (sandbox, forks, outbound gateway,
 * merge Workflow), so this Worker cannot launch an agent or merge into a repository.
 */

type Vars = { Bindings: AdviseEnv; Variables: { who: Identity } };

const app = new Hono<Vars>();

app.onError((err, c) => {
  if (err instanceof AccessError) return c.json({ error: err.message }, err.status);
  if (err instanceof ClaimError) return c.json({ error: err.message }, err.status);
  console.error("request failed", c.req.method, c.req.path, err instanceof Error ? err.message : String(err));
  return c.json({ error: "internal error" }, 500);
});

app.get("/health", async (c) => c.json({ ok: true, deployment: "advise", polledAt: await getSetting(c.env, "polled_at") }));

app.use("*", async (c, next) => {
  c.set("who", await verifyAccess(c.env, c.req.raw));
  await next();
});

const queryPaths = (raw: string | undefined) => cleanPaths((raw ?? "").split(",").filter(Boolean));

app.get("/v1/inflight", async (c) => {
  const repo = repoName(c.req.query("repo"), config.advise.owner);
  const f = await inFlight(c.env, { repo, paths: queryPaths(c.req.query("paths")), text: c.req.query("goal"), branch: c.req.query("branch") });
  return c.json(toJson(f));
});

app.get("/v1/brief", async (c) => {
  const repo = repoName(c.req.query("repo"), config.advise.owner);
  const f = await inFlight(c.env, { repo, paths: queryPaths(c.req.query("paths")), text: c.req.query("goal"), branch: c.req.query("branch") });
  return c.text(briefText(f));
});

app.post("/v1/check", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const base = typeof body.base === "string" ? body.base : "";
  if (!/^[0-9a-f]{7,40}$/.test(base)) return c.json({ error: "base must be a commit SHA" }, 400);
  const result = await check(c.env, {
    repo: repoName(body.repo, config.advise.owner),
    base,
    paths: cleanPaths(body.paths),
    branch: typeof body.branch === "string" ? body.branch : undefined,
    text: typeof body.goal === "string" ? body.goal : undefined,
  });
  return c.json({
    text: checkText(result),
    behind: result.behind,
    collisions: result.collisions,
    head: result.head,
    defaultBranch: result.defaultBranch,
    near: toJson(result.inflight).near.filter((n) => n.shared.length > 0),
  });
});

app.get("/v1/claims", async (c) => {
  const repo = c.req.query("repo") ? repoName(c.req.query("repo"), config.advise.owner) : undefined;
  return c.json({ claims: await listClaims(c.env, repo) });
});

app.post("/v1/claims", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const claim = await createClaim(c.env, c.get("who").who, body as never);
  const f = await inFlight(c.env, { repo: claim.repo, paths: claim.paths, text: claim.goal, branch: claim.branch ?? undefined, claim: claim.id });
  return c.json({ claim, brief: briefText(f) }, 201);
});

app.post("/v1/claims/:id/renew", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return c.json({ claim: await extendClaim(c.env, c.get("who").who, c.req.param("id"), body.ttl_minutes) });
});

app.delete("/v1/claims/:id", async (c) => {
  await dropClaim(c.env, c.get("who").who, c.req.param("id"));
  return c.json({ released: c.req.param("id") });
});

app.post("/v1/poll", async (c) => c.json(await poll(c.env)));

app.get("/v1/status", async (c) => {
  const report = await getSetting(c.env, "poll_report");
  return c.json({ who: c.get("who"), polledAt: await getSetting(c.env, "polled_at"), lastPoll: report ? JSON.parse(report) : null });
});

app.all("/mcp", (c) => handleMcp(c.env, c.get("who"), c.req.raw));

app.notFound((c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: AdviseEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      poll(env).then(
        (r) => {
          if (r.errors.length) console.warn("poll errors", r.errors.join("; "));
        },
        (err) => console.error("poll failed", err instanceof Error ? err.message : String(err)),
      ),
    );
  },
} satisfies ExportedHandler<AdviseEnv>;

export { app };
