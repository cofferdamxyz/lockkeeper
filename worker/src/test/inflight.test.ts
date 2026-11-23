import { beforeEach, describe, expect, it } from "vitest";

import { ClaimError, createClaim, dropClaim, extendClaim } from "../claims";
import { briefText, check, checkText, inFlight } from "../inflight";
import { poll } from "../poll";
import { commit, fakeFetch, resetDb, testEnv, type FakeGitHub, type FakeRepo } from "./fakes";

async function seeded() {
  const env = await testEnv();
  const root = commit("init", ["README.md", "src/lib/theme.ts"]);
  const app: FakeRepo = {
    name: "cofferdam-app",
    pushedAt: "2026-10-22T01:00:00Z",
    main: [root],
    branches: {
      "claude/i18n": { base: root.sha, commits: [commit("i18n: es-MX strings", ["src/i18n/es-MX.json", "src/lib/theme.ts"])] },
      "claude/other": { base: root.sha, commits: [commit("docs", ["README.md"])] },
    },
    pulls: [{ number: 3, title: "Spanish strings", branch: "claude/i18n", draft: true }],
  };
  const gh: FakeGitHub = { owner: "cofferdamxyz", repos: [app], calls: [] };
  await poll(env, { fetcher: fakeFetch(gh) });
  return { env, gh, app, root };
}

describe("in flight", () => {
  beforeEach(async () => resetDb(await testEnv()));

  it("answers with the branches and claims that share paths", async () => {
    const { env } = await seeded();
    await createClaim(env, "service:abc", { repo: "cofferdam-app", goal: "Light-mode pass on the theme", paths: ["src/lib/**"], session: "Light mode" });
    const f = await inFlight(env, { repo: "cofferdamxyz/cofferdam-app", paths: ["src/lib/theme.ts"] });
    expect(f.near.map((n) => [n.kind, n.id.startsWith("cl-") ? "claim" : n.id])).toEqual([
      ["branch", "claude/i18n"],
      ["claim", "claim"],
    ]);
    expect(f.others).toBe(1);
    const text = briefText(f);
    expect(text).toContain("branch `claude/i18n`: PR #3 (draft)");
    expect(text).toContain("shares `src/lib/theme.ts`");
    expect(text).toContain("claimed by Light mode (service:abc)");
    expect(text).toContain("Awareness, not a lock");
  });

  it("lists everything when asked about nothing in particular, minus the asker's own branch", async () => {
    const { env } = await seeded();
    const f = await inFlight(env, { repo: "cofferdamxyz/cofferdam-app", paths: [], branch: "claude/other" });
    expect(f.near.map((n) => n.id)).toEqual(["claude/i18n"]);
  });

  it("checks a push live: what moved on main since the base and which files collide", async () => {
    const { env, gh, app, root } = await seeded();
    app.main.push(commit("theme: makeStyles everywhere", ["src/lib/theme.ts", "src/ui/Button.tsx"]));
    const c = await check(env, { repo: "cofferdamxyz/cofferdam-app", base: root.sha, paths: ["src/lib/theme.ts", "src/app/x.tsx"], branch: "claude/mine" }, { fetcher: fakeFetch(gh) });
    expect(c.behind).toBe(1);
    expect(c.collisions).toEqual(["src/lib/theme.ts"]);
    const text = checkText(c);
    expect(text).toContain("main moved 1 commit since your base (2 files)");
    expect(text).toContain("Rebase onto origin/main before you push");
    expect(text).toContain("branch `claude/i18n`");
  });
});

describe("claims", () => {
  beforeEach(async () => resetDb(await testEnv()));

  it("expire on their own, cap their time to live, and only their owner renews or releases them", async () => {
    const env = await testEnv();
    const t0 = new Date("2026-10-22T03:00:00Z");
    const c = await createClaim(env, "a@cofferdam.xyz", { repo: "cofferdam-api", goal: "x", ttl_minutes: 10_000 }, { now: t0 });
    expect(Date.parse(c.expires_at) - t0.getTime()).toBe(240 * 60_000);
    await expect(dropClaim(env, "b@cofferdam.xyz", c.id)).rejects.toMatchObject({ status: 403 });
    const later = new Date(t0.getTime() + 300 * 60_000);
    await expect(extendClaim(env, "a@cofferdam.xyz", c.id, 30, { now: later })).rejects.toBeInstanceOf(ClaimError);
    const f = await inFlight(env, { repo: "cofferdamxyz/cofferdam-api", paths: [] }, { now: later });
    expect(f.near).toEqual([]);
  });

  it("need a goal and a real repository", async () => {
    const env = await testEnv();
    await expect(createClaim(env, "a", { repo: "cofferdam-api" })).rejects.toMatchObject({ status: 400 });
    await expect(createClaim(env, "a", { repo: "../../x y", goal: "g" })).rejects.toMatchObject({ status: 400 });
  });
});
