import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../index";
import { TOOLS } from "../mcp";
import { commit, fakeAccess, fakeFetch, resetDb, testEnv, type FakeGitHub, type FakeRepo } from "./fakes";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function harness() {
  const env = await testEnv();
  await resetDb(env);
  const access = await fakeAccess();
  const root = commit("init", ["src/index.ts"]);
  const api: FakeRepo = {
    name: "cofferdam-api",
    pushedAt: "2026-10-22T01:00:00Z",
    main: [root],
    branches: { "claude/limits": { base: root.sha, commits: [commit("limits", ["src/routes/aa.ts"])] } },
  };
  const gh: FakeGitHub = { owner: "cofferdamxyz", repos: [api], calls: [] };
  const github = fakeFetch(gh);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith("https://cofferdam.cloudflareaccess.com") ? access.fetcher(input, init) : github(input, init);
  });
  const token = await access.sign(access.claims({ common_name: "claude-code.access" }));
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`https://lockkeeper.cofferdam.xyz${path}`, { ...init, headers: { "cf-access-jwt-assertion": token, "content-type": "application/json", ...(init.headers ?? {}) } }), env, ctx);
  const rpc = async (method: string, params?: unknown, id: number | undefined = 1) => {
    const res = await call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) });
    return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as Record<string, any>) };
  };
  return { env, gh, api, root, call, rpc };
}

describe("the HTTP API and the MCP server", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => vi.restoreAllMocks());

  it("refuses everything but /health without Access", async () => {
    const env = await testEnv();
    expect((await app.fetch(new Request("https://lockkeeper.cofferdam.xyz/health"), env, ctx)).status).toBe(200);
    expect((await app.fetch(new Request("https://lockkeeper.cofferdam.xyz/mcp", { method: "POST", body: "{}" }), env, ctx)).status).toBe(401);
    expect((await app.fetch(new Request("https://lockkeeper.cofferdam.xyz/v1/brief?repo=cofferdam-api"), env, ctx)).status).toBe(401);
  });

  it("polls, then briefs and claims over HTTP", async () => {
    expect((await h.call("/v1/poll", { method: "POST" })).status).toBe(200);
    const brief = await (await h.call("/v1/brief?repo=cofferdam-api&paths=src/routes/aa.ts")).text();
    expect(brief).toContain("branch `claude/limits`");
    const res = await h.call("/v1/claims", { method: "POST", body: JSON.stringify({ repo: "cofferdam-api", goal: "Relay nonce lanes", paths: ["src/routes/"] }) });
    expect(res.status).toBe(201);
    const { claim } = (await res.json()) as { claim: { id: string; who: string } };
    expect(claim.who).toBe("service:claude-code.access");
    expect((await h.call(`/v1/claims/${claim.id}`, { method: "DELETE" })).status).toBe(200);
    const status = (await (await h.call("/v1/status")).json()) as { lastPoll: { repos: number } };
    expect(status.lastPoll.repos).toBe(1);
  });

  it("speaks MCP: initialize, tools, a claim, a check, notifications", async () => {
    const init = await h.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } });
    expect(init.body?.result.protocolVersion).toBe("2025-06-18");
    expect(init.body?.result.capabilities.tools).toBeDefined();
    expect((await h.rpc("notifications/initialized", undefined, undefined)).status).toBe(202);
    const list = await h.rpc("tools/list");
    expect(list.body?.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));

    await h.call("/v1/poll", { method: "POST" });
    const claimed = await h.rpc("tools/call", { name: "claim", arguments: { repo: "cofferdam-api", goal: "Per-sender limits", paths: ["src/routes/aa.ts"], session: "night" } });
    const text: string = claimed.body?.result.content[0].text;
    expect(text).toMatch(/^Claim cl-[0-9a-f]{16} on cofferdamxyz\/cofferdam-api/);
    expect(text).toContain("branch `claude/limits`");

    h.api.main.push(commit("aa: relay caps", ["src/routes/aa.ts"]));
    const checked = await h.rpc("tools/call", { name: "check", arguments: { repo: "cofferdam-api", base: h.root.sha, paths: ["src/routes/aa.ts"] } });
    expect(checked.body?.result.content[0].text).toContain("It changed files you changed too: `src/routes/aa.ts`");

    const bad = await h.rpc("tools/call", { name: "check", arguments: { repo: "cofferdam-api", base: "HEAD", paths: [] } });
    expect(bad.body?.result.isError).toBe(true);
    expect((await h.rpc("nope")).body?.error.code).toBe(-32601);
    expect((await h.call("/mcp")).status).toBe(405);
  });
});
