import { beforeEach, describe, expect, it } from "vitest";

import { createClaim } from "../claims";
import { poll } from "../poll";
import { activeClaims, getBranches, recentMainMoves } from "../store";
import { commit, fakeFetch, resetDb, testEnv, type FakeGitHub, type FakeRepo } from "./fakes";

function world(): { gh: FakeGitHub; api: FakeRepo } {
  const root = commit("init", ["README.md"]);
  const api: FakeRepo = {
    name: "cofferdam-api",
    pushedAt: "2026-10-22T01:00:00Z",
    main: [root],
    branches: {
      "claude/auth-fix": { base: root.sha, commits: [commit("auth: check expiry", ["src/services/sessionAttestation.ts", "test/auth.test.ts"])] },
      "claude/merged": { base: root.sha, commits: [] },
      // An orphan release branch (cofferdam-sdk has these): no common ancestor with main.
      "release-core-main": { base: "", commits: [commit("release: core", ["dist/index.js"])] },
    },
    pulls: [{ number: 7, title: "Check csa1 expiry", branch: "claude/auth-fix" }],
    comments: {},
  };
  const gh: FakeGitHub = {
    owner: "cofferdamxyz",
    calls: [],
    repos: [api, { name: "cofferdam-prover", pushedAt: "x", main: [commit("x", ["a"])], branches: {} }, { name: "old", archived: true, pushedAt: "x", main: [commit("x", ["a"])], branches: {} }],
  };
  return { gh, api };
}

describe("the poller", () => {
  beforeEach(async () => resetDb(await testEnv()));

  it("indexes branches ahead of main with their pull request, CI and sensitive paths", async () => {
    const env = await testEnv();
    const { gh, api } = world();
    const head = api.branches["claude/auth-fix"].commits[0].sha;
    api.comments![7] = [{ body: `<!-- cofferdam-ci:check -->\n### CI ✅ passed · \`check\` on ${head.slice(0, 7)}`, user: { type: "Bot" }, updated_at: "" }];
    const r = await poll(env, { fetcher: fakeFetch(gh) });
    expect(r.errors).toEqual([]);
    expect(r.repos).toBe(1); // the prover is excluded, the archived repository skipped
    const [b, ...rest] = await getBranches(env, "cofferdamxyz/cofferdam-api");
    expect(rest).toEqual([]); // `claude/merged` is not ahead of main; the orphan `release-core-main` is skipped, not an error
    expect(b).toMatchObject({ name: "claude/auth-fix", ahead: 1, behind: 0, pr_number: 7, ci: "pass", sensitive: ["src/services/sessionAttestation.ts"] });
    expect(b.files).toEqual(["src/services/sessionAttestation.ts", "test/auth.test.ts"]);
    expect(gh.calls.some((c) => c.startsWith("POST") && !c.includes("access_tokens"))).toBe(false); // reads only
  });

  it("skips the branch scan when nothing was pushed, and records main moving", async () => {
    const env = await testEnv();
    const { gh, api } = world();
    await poll(env, { fetcher: fakeFetch(gh) });
    gh.calls.length = 0;
    await poll(env, { fetcher: fakeFetch(gh) });
    expect(gh.calls.filter((c) => c.includes("/branches") || c.includes("/compare/"))).toEqual([]);

    api.main.push(commit("chat: router floor", ["src/services/chat/router.ts"]));
    api.pushedAt = "2026-10-22T02:00:00Z";
    const r = await poll(env, { fetcher: fakeFetch(gh) });
    expect(r.mainMoves).toBe(1);
    const moves = await recentMainMoves(env, "cofferdamxyz/cofferdam-api", "2000-01-01");
    expect(moves[0].files).toEqual(["src/services/chat/router.ts"]);
    expect(moves[0].commits[0]).toMatch(/chat: router floor$/);
    const [b] = await getBranches(env, "cofferdamxyz/cofferdam-api");
    expect(b.behind).toBe(1);
  });

  it("drops deleted branches and releases the claim a pushed branch answers", async () => {
    const env = await testEnv();
    const { gh, api } = world();
    await createClaim(env, "hoff@cofferdam.xyz", { repo: "cofferdam-api", goal: "Rate limit the relay", paths: ["src/routes/aa.ts"], branch: "claude/relay-rl" });
    await poll(env, { fetcher: fakeFetch(gh) });
    expect(await activeClaims(env, new Date().toISOString())).toHaveLength(1);

    delete api.branches["claude/auth-fix"];
    api.pulls = [];
    api.branches["claude/relay-rl"] = { base: api.main[0].sha, commits: [commit("relay: per-sender limit", ["src/routes/aa.ts"])] };
    api.pushedAt = "2026-10-22T03:00:00Z";
    const r = await poll(env, { fetcher: fakeFetch(gh) });
    expect(r.branchesRemoved).toBe(1);
    expect((await getBranches(env, "cofferdamxyz/cofferdam-api")).map((b) => b.name)).toEqual(["claude/relay-rl"]);
    expect(await activeClaims(env, new Date().toISOString())).toHaveLength(0);
  });

  it("never runs twice at once", async () => {
    const env = await testEnv();
    const { gh } = world();
    const [a, b] = await Promise.all([poll(env, { fetcher: fakeFetch(gh) }), poll(env, { fetcher: fakeFetch(gh) })]);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
  });
});
