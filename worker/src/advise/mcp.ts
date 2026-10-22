import config from "../../../lockkeeper.config";
import type { Identity } from "./access";
import { ClaimError, createClaim, dropClaim, extendClaim, repoName } from "./claims";
import type { AdviseEnv } from "./env";
import { briefText, check, checkText, inFlight } from "./inflight";
import { cleanPaths } from "./paths";
import { getBranches, getRepos, activeClaims } from "./store";
import type { Fetch } from "./github";

/**
 * The MCP server (DESIGN.md §13 step 2): Streamable HTTP at `/mcp`, stateless, JSON responses,
 * behind Access with a service token. It serves Claude Code's touchpoints: the brief and a claim
 * at session start, the check before commit and push. Every tool reads or writes only
 * Lockkeeper's own ledger; none launches an agent, opens a pull request or merges.
 */

export const SERVER_INFO = { name: "lockkeeper", version: "0.2.0" };
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = [
  "Lockkeeper tells you what else is in flight in a Cofferdam repository: branches, open pull requests and claims by other sessions, and what landed on the default branch.",
  "At the start of work call `brief`; once you know which paths you will touch, call `claim` with them and a one-line goal, and `release_claim` when you stop without pushing.",
  "Before a commit or a push call `check` with your merge base and changed paths.",
  "It is awareness, never a lock: main always wins, branches rebase onto it, and nothing here stops you.",
].join(" ");

const repoProp = { type: "string", description: "Repository, `cofferdamxyz/<name>` or just `<name>`." };
const pathsProp = { type: "array", items: { type: "string" }, description: "Paths relative to the repository root; directories end with `/`, globs use `*` and `**`." };

export const TOOLS = [
  {
    name: "brief",
    description: "What is in flight near your work in one repository, and what landed on its default branch recently. Call at session start.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, paths: pathsProp, goal: { type: "string", description: "One line on what you are doing (improves similarity)." }, branch: { type: "string", description: "Your own branch, left out of the answer." } },
      required: ["repo"],
    },
  },
  {
    name: "claim",
    description: "Say you are about to work on these paths, so other sessions see it before your branch is pushed. Expires on its own (default 60 min, max 240) and is released when your branch reaches GitHub. Returns the claim id and the brief.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        paths: pathsProp,
        goal: { type: "string", description: "One sentence on what the work is." },
        branch: { type: "string", description: "The branch you will push, if known." },
        session: { type: "string", description: "A short label for this session (thread title, task)." },
        ttl_minutes: { type: "number" },
      },
      required: ["repo", "goal"],
    },
  },
  {
    name: "renew_claim",
    description: "Extend one of your claims.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ttl_minutes: { type: "number" } }, required: ["id"] },
  },
  {
    name: "release_claim",
    description: "Release one of your claims (you stopped, or changed plan).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "check",
    description: "Before a commit or push: what moved on the default branch since your base, which of those files you also changed, and other work in flight on your files.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        base: { type: "string", description: "Your merge base: `git merge-base HEAD origin/main`." },
        paths: pathsProp,
        branch: { type: "string" },
        goal: { type: "string" },
      },
      required: ["repo", "base", "paths"],
    },
  },
  {
    name: "in_flight",
    description: "Every branch and claim in flight, per repository (or one repository).",
    inputSchema: { type: "object", properties: { repo: repoProp } },
  },
];

type Json = Record<string, unknown>;
interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(env: AdviseEnv, who: Identity, name: string, args: Json, fetcher?: Fetch) {
  const owner = config.advise.owner;
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  switch (name) {
    case "brief": {
      const f = await inFlight(env, { repo: repoName(args.repo, owner), paths: cleanPaths(args.paths), text: str("goal"), branch: str("branch") });
      return text(briefText(f));
    }
    case "claim": {
      const c = await createClaim(env, who.who, args as never);
      const f = await inFlight(env, { repo: c.repo, paths: c.paths, text: c.goal, branch: c.branch ?? undefined, claim: c.id });
      return text(`Claim ${c.id} on ${c.repo} until ${c.expires_at}${c.paths.length ? ` for ${c.paths.join(", ")}` : " (whole repository)"}.\n\n${briefText(f)}`);
    }
    case "renew_claim": {
      const c = await extendClaim(env, who.who, String(args.id ?? ""), args.ttl_minutes);
      return text(`Claim ${c.id} now runs until ${c.expires_at}.`);
    }
    case "release_claim": {
      await dropClaim(env, who.who, String(args.id ?? ""));
      return text(`Claim ${String(args.id)} released.`);
    }
    case "check": {
      const base = str("base");
      if (!base || !/^[0-9a-f]{7,40}$/.test(base)) return text("base must be a commit SHA (git merge-base HEAD origin/main).", true);
      const c = await check(env, { repo: repoName(args.repo, owner), base, paths: cleanPaths(args.paths), branch: str("branch"), text: str("goal") }, { fetcher });
      return text(checkText(c));
    }
    case "in_flight": {
      const only = args.repo ? repoName(args.repo, owner) : undefined;
      const claims = await activeClaims(env, new Date().toISOString());
      const known = await getRepos(env);
      // Claims may name a repository the poller has not read yet.
      for (const c of claims) if (!known.some((r) => r.repo === c.repo)) known.push({ repo: c.repo, default_branch: "main", head_sha: null, pushed_at: null, polled_at: null });
      const repos = known.filter((r) => !only || r.repo === only);
      const lines: string[] = [];
      for (const r of repos) {
        const bs = await getBranches(env, r.repo);
        const cs = claims.filter((c) => c.repo === r.repo);
        if (!bs.length && !cs.length && !only) continue;
        lines.push(`${r.repo}${r.head_sha ? ` (${r.default_branch} at ${r.head_sha.slice(0, 7)})` : " (not polled yet)"}:`);
        for (const b of bs) lines.push(`- \`${b.name}\` ${b.ahead} ahead${b.pr_number ? `, PR #${b.pr_number}` : ""}${b.ci !== "none" ? `, CI ${b.ci}` : ""}, ${b.files.length} files`);
        for (const c of cs) lines.push(`- claim "${c.goal}" by ${c.session ?? c.who}${c.paths.length ? ` on ${c.paths.slice(0, 4).join(", ")}` : ""}`);
      }
      return text(lines.length ? lines.join("\n") : "Nothing in flight.");
    }
    default:
      throw new RpcError(-32602, `unknown tool: ${name}`);
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function handleOne(env: AdviseEnv, who: Identity, req: RpcRequest, fetcher?: Fetch): Promise<Json | null> {
  const isNotification = req.id === undefined || req.id === null;
  const reply = (result: unknown): Json => ({ jsonrpc: "2.0", id: req.id ?? null, result });
  try {
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") throw new RpcError(-32600, "invalid request");
    let result: unknown;
    switch (req.method) {
      case "initialize": {
        const asked = String(req.params?.protocolVersion ?? "");
        result = {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Json;
        try {
          result = await callTool(env, who, name, args, fetcher);
        } catch (err) {
          if (err instanceof RpcError) throw err;
          // Tool failures go back to the model as text, so a session can carry on without Lockkeeper.
          const msg = err instanceof ClaimError || err instanceof Error ? err.message : String(err);
          result = text(`Lockkeeper could not answer: ${msg}`, true);
        }
        break;
      }
      default:
        if (req.method.startsWith("notifications/")) return null;
        throw new RpcError(-32601, `method not found: ${req.method}`);
    }
    return isNotification ? null : reply(result);
  } catch (err) {
    if (isNotification) return null;
    const code = err instanceof RpcError ? err.code : -32603;
    return { jsonrpc: "2.0", id: req.id ?? null, error: { code, message: err instanceof Error ? err.message : String(err) } };
  }
}

export async function handleMcp(env: AdviseEnv, who: Identity, request: Request, fetcher?: Fetch): Promise<Response> {
  if (request.method !== "POST") {
    // Stateless: no server-to-client stream and no session to delete.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((r) => handleOne(env, who, r as RpcRequest, fetcher)))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const one = await handleOne(env, who, body as RpcRequest, fetcher);
  return one ? Response.json(one) : new Response(null, { status: 202 });
}
