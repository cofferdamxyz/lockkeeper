import { Hono } from "hono";

import config from "../../lockkeeper.config";
import { AccessError, verifyAccess, type Identity } from "./access";
import { advise, landingOrder } from "./advice";
import { ClaimError, createClaim, dropClaim, extendClaim, listClaims, repoName } from "./claims";
import type { LockkeeperEnv } from "./env";
import { briefText, check, checkText, inFlight, toJson } from "./inflight";
import { handleMcp } from "./mcp";
import { MONITOR_HEADERS, monitorData, renderMonitor } from "./monitor";
import { GEIST_MONO_WOFF2, GEIST_WOFF2 } from "./monitorFonts";
import { cleanPaths } from "./paths";
import { poll } from "./poll";
import { present } from "./present";
import { getSetting } from "./store";

/**
 * Lockkeeper: awareness and landing advice over an organisation's repositories on GitHub
 * (DESIGN.md). Headless: an HTTP API and an MCP server behind Cloudflare Access, and a cron that
 * polls GitHub and then asks Clef about the open pull requests. It cannot launch an agent or merge
 * into a repository: its only writes to GitHub are its token request and the advice comment.
 */

type Vars = { Bindings: LockkeeperEnv; Variables: { who: Identity } };

const app = new Hono<Vars>();

app.onError((err, c) => {
  if (err instanceof AccessError) return c.json({ error: err.message }, err.status);
  if (err instanceof ClaimError) return c.json({ error: err.message }, err.status);
  console.error("request failed", c.req.method, c.req.path, err instanceof Error ? err.message : String(err));
  return c.json({ error: "internal error" }, 500);
});

app.get("/health", async (c) => c.json({ ok: true, polledAt: await getSetting(c.env, "polled_at") }));

app.use("*", async (c, next) => {
  c.set("who", await verifyAccess(c.env, c.req.raw));
  await next();
});

// The monitor: one page for a person, behind Access like everything below (DESIGN.md, "The monitor").
app.get("/", async (c) => {
  const raw = c.req.query("repo");
  const repo = raw ? repoName(raw, config.owner) : undefined;
  return new Response(renderMonitor(await monitorData(c.env, c.get("who"), repo)), { headers: MONITOR_HEADERS });
});

const FONTS: Record<string, string> = { "geist.woff2": GEIST_WOFF2, "geist-mono.woff2": GEIST_MONO_WOFF2 };
app.get("/monitor/:font", (c) => {
  const name = c.req.param("font");
  if (!Object.hasOwn(FONTS, name)) return c.json({ error: "not found" }, 404);
  const b64 = FONTS[name];
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": "font/woff2", "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
});

const queryPaths = (raw: string | undefined) => cleanPaths((raw ?? "").split(",").filter(Boolean));

app.get("/v1/inflight", async (c) => {
  const repo = repoName(c.req.query("repo"), config.owner);
  const f = await inFlight(c.env, { repo, paths: queryPaths(c.req.query("paths")), text: c.req.query("goal"), branch: c.req.query("branch") });
  return c.json(toJson(f));
});

app.get("/v1/brief", async (c) => {
  const repo = repoName(c.req.query("repo"), config.owner);
  const f = await inFlight(c.env, { repo, paths: queryPaths(c.req.query("paths")), text: c.req.query("goal"), branch: c.req.query("branch") });
  return c.text(briefText(f));
});

app.post("/v1/check", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const base = typeof body.base === "string" ? body.base : "";
  if (!/^[0-9a-f]{7,40}$/.test(base)) return c.json({ error: "base must be a commit SHA" }, 400);
  const result = await check(c.env, {
    repo: repoName(body.repo, config.owner),
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
  const repo = c.req.query("repo") ? repoName(c.req.query("repo"), config.owner) : undefined;
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

app.post("/v1/poll", async (c) => c.json(await poll(c.env, { retryChecks: true })));

// The landing order per repository, with each candidate's verdict and its issue.
app.get("/v1/advice", async (c) => {
  const repo = c.req.query("repo") ? repoName(c.req.query("repo"), config.owner) : undefined;
  return c.json({ repos: await landingOrder(c.env, repo) });
});

// One read for the Development Tracker's Present column (through the OS gatekeeper).
app.get("/v1/present", async (c) => {
  const repo = c.req.query("repo") ? repoName(c.req.query("repo"), config.owner) : undefined;
  return c.json(await present(c.env, repo));
});

app.post("/v1/advise", async (c) => c.json(await advise(c.env, { force: c.req.query("force") === "1" })));

app.get("/v1/status", async (c) => {
  const report = await getSetting(c.env, "poll_report");
  const advised = await getSetting(c.env, "advise_report");
  return c.json({
    who: c.get("who"),
    polledAt: await getSetting(c.env, "polled_at"),
    lastPoll: report ? JSON.parse(report) : null,
    lastAdvice: advised ? JSON.parse(advised) : null,
  });
});

app.all("/mcp", (c) => handleMcp(c.env, c.get("who"), c.req.raw));

app.notFound((c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: LockkeeperEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      poll(env)
        .then(
          (r) => {
            if (r.errors.length) console.warn("poll errors", r.errors.join("; "));
          },
          (err) => console.error("poll failed", err instanceof Error ? err.message : String(err)),
        )
        // The advising pass reads what the poll just wrote; it asks Clef only where candidates moved.
        .then(() => advise(env))
        .then(
          (r) => {
            if (r.errors.length) console.warn("advise errors", r.errors.join("; "));
          },
          (err) => console.error("advise failed", err instanceof Error ? err.message : String(err)),
        ),
    );
  },
} satisfies ExportedHandler<LockkeeperEnv>;

export { app };
