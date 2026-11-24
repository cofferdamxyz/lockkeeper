import { beforeEach, describe, expect, it } from "vitest";

import { createClaim } from "../claims";
import config from "../../../lockkeeper.config";
import { changedPaths } from "../github";
import { CHECKS_BLOCKED, poll } from "../poll";
import { activeClaims, getBranches, getSetting, recentMainMoves } from "../store";
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

  it("does not write a landed branch back in the poll that removes it", async () => {
    const env = await testEnv();
    const { gh, api } = world();
    await poll(env, { fetcher: fakeFetch(gh) });
    expect((await getBranches(env, "cofferdamxyz/cofferdam-api")).map((b) => b.name)).toEqual(["claude/auth-fix"]);

    // The branch lands by fast-forward and is kept; its pull request closes.
    api.main.push(...api.branches["claude/auth-fix"].commits);
    api.branches["claude/auth-fix"] = { base: api.main[api.main.length - 1].sha, commits: [] };
    api.pulls = [];
    api.pushedAt = "2026-10-22T04:00:00Z";
    const r = await poll(env, { fetcher: fakeFetch(gh) });
    expect(r.branchesRemoved).toBe(1);
    expect(await getBranches(env, "cofferdamxyz/cofferdam-api")).toEqual([]);
    await poll(env, { fetcher: fakeFetch(gh) });
    expect(await getBranches(env, "cofferdamxyz/cofferdam-api")).toEqual([]);
  });

  it("counts a renamed file under both of its names", () => {
    const cmp = { ahead_by: 1, behind_by: 0, merge_base_commit: { sha: "x" }, commits: [], files: [{ filename: "docs/ci.yml", previous_filename: ".github/workflows/ci.yml" }, { filename: "README.md" }] };
    expect(changedPaths(cmp)).toEqual(["docs/ci.yml", ".github/workflows/ci.yml", "README.md"]);
  });

  it("never runs twice at once", async () => {
    const env = await testEnv();
    const { gh } = world();
    const [a, b] = await Promise.all([poll(env, { fetcher: fakeFetch(gh) }), poll(env, { fetcher: fakeFetch(gh) })]);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
  });

  describe("CI from check runs", () => {
    const checksFirst = { ...config, ci: { ...config.ci, sources: ["checks", "comment"] as ("checks" | "comment")[] } };
    const checksOnly = { ...config, ci: { ...config.ci, sources: ["checks"] as ("checks" | "comment")[] } };
    // By name: rows come back newest commit first, and a test with two branches must not depend on which commit got the later millisecond.
    const ciOf = async (env: Awaited<ReturnType<typeof testEnv>>) => (await getBranches(env, "cofferdamxyz/cofferdam-api")).find((b) => b.name === "claude/auth-fix")!.ci;
    const comment = (head: string, word = "✅ passed") => ({ body: `<!-- cofferdam-ci:check -->\n### CI ${word} · \`check\` on ${head.slice(0, 7)}`, user: { type: "Bot" }, updated_at: "" });
    const checkCalls = (gh: FakeGitHub) => gh.calls.filter((c) => c.includes("/check-runs"));

    it("is green only when every source says so", async () => {
      const env = await testEnv();
      const { gh, api } = world();
      const head = api.branches["claude/auth-fix"].commits[0].sha;
      const poll2 = async () => {
        gh.calls.length = 0;
        const r = await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst });
        expect(r.errors).toEqual([]);
        expect(r.notes).toBeUndefined();
        return ciOf(env);
      };
      const success = { name: "check", status: "completed", conclusion: "success" };

      api.checks = { [head]: [success] };
      api.comments![7] = [comment(head)];
      expect(await poll2()).toBe("pass"); // both say passed

      api.checks[head] = [{ name: "check", status: "completed", conclusion: "failure" }];
      expect(await poll2()).toBe("fail"); // the comment says passed; a failed run is worse
      expect(gh.calls.filter((c) => c.includes("/issues/7/comments"))).toEqual([]); // nothing can be worse than failed: not asked

      api.checks[head] = [success, { name: "e2e", status: "in_progress", conclusion: null }];
      expect(await poll2()).toBe("pending");

      // A green run from anyone does not stand in for the CI's own report.
      api.checks[head] = [{ name: "Some Deploy App", status: "completed", conclusion: "success" }];
      api.comments![7] = []; // the CI never commented on this head: `[skip ci]`, a workflow that did not trigger
      expect(await poll2()).toBe("none");
      api.comments![7] = [comment("1111111aaaaaaa")]; // or its comment still names an older head
      expect(await poll2()).toBe("pending");
      api.comments![7] = [comment(head, "❌ failed")];
      expect(await poll2()).toBe("fail");

      // And the comment does not stand in for the check runs.
      api.comments![7] = [comment(head)];
      api.checks[head] = [];
      expect(await poll2()).toBe("none");
      expect(gh.calls.some((c) => c.startsWith("POST") && !c.includes("access_tokens"))).toBe(false); // reads only
    });

    it("needs the checks the configuration requires, and all of the head's runs", async () => {
      const env = await testEnv();
      const { gh, api } = world();
      const head = api.branches["claude/auth-fix"].commits[0].sha;
      api.checks = { [head]: [{ name: "Vercel", status: "completed", conclusion: "success" }] };
      const required = { ...config, ci: { ...config.ci, sources: ["checks"] as ("checks" | "comment")[], requireChecks: ["check"] } };
      await poll(env, { fetcher: fakeFetch(gh), settings: required });
      expect(await ciOf(env)).toBe("pending"); // the CI did not run on this head
      api.checks[head].push({ name: "check", status: "completed", conclusion: "success" });
      await poll(env, { fetcher: fakeFetch(gh), settings: required });
      expect(await ciOf(env)).toBe("pass");

      api.checksEndless = true; // more runs than the three pages Lockkeeper reads
      gh.calls.length = 0;
      await poll(env, { fetcher: fakeFetch(gh), settings: required });
      expect(checkCalls(gh)).toHaveLength(3);
      expect(await ciOf(env)).toBe("pending");
    });

    it("reads a refusal as a refusal: the comment answers, the report says so, and check runs wait", async () => {
      const env = await testEnv();
      const { gh, api } = world();
      const head = api.branches["claude/auth-fix"].commits[0].sha;
      api.comments![7] = [comment(head)];
      // A second pull request, so that "asked once" means something.
      api.branches["claude/second"] = { base: api.main[0].sha, commits: [commit("docs: a note", ["README.md"])] };
      api.pulls!.push({ number: 8, title: "A note", branch: "claude/second" });
      // `api.checks` is unset: GitHub answers an App without Checks read with 403.
      const t0 = new Date("2026-11-23T12:00:00Z");
      const r = await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst, now: () => t0 });
      expect(r.errors).toEqual([]);
      expect(r.repos).toBe(1);
      expect(await ciOf(env)).toBe("pass");
      expect(checkCalls(gh)).toHaveLength(1); // asked once, then not again in this pass, with two pull requests open
      expect(gh.calls.filter((c) => /\/issues\/\d+\/comments/.test(c))).toHaveLength(2); // both still read from the comment
      expect(r.notes?.[0]).toContain("GitHub refused check runs");
      expect(r.notes?.[0]).toContain("2026-11-23T18:00:00.000Z");
      expect(r.notes?.[0]).toContain("CI is read from: comment.");
      expect(await getSetting(env, CHECKS_BLOCKED)).toBe("2026-11-23T18:00:00.000Z");

      gh.calls.length = 0;
      const later = await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst, now: () => new Date("2026-11-23T13:00:00Z") });
      expect(checkCalls(gh)).toEqual([]); // paused: not asked
      expect(later.notes?.[0]).toContain("2026-11-23T18:00:00.000Z"); // and still said
      expect(await ciOf(env)).toBe("pass");

      // A poll someone asks for that finds no pull request to ask about is not a grant: the note stays.
      const pulls = api.pulls!;
      api.pulls = [];
      const empty = await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst, now: () => new Date("2026-11-23T13:02:00Z"), retryChecks: true });
      expect(checkCalls(gh)).toEqual([]);
      expect(empty.notes?.[0]).toContain("2026-11-23T18:00:00.000Z");
      expect(await getSetting(env, CHECKS_BLOCKED)).toBe("2026-11-23T18:00:00.000Z");
      api.pulls = pulls;

      // The permission is granted. A poll someone asks for tries again at once, and the pause ends.
      api.checks = { [head]: [{ name: "check", status: "completed", conclusion: "success" }] };
      const asked = await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst, now: () => new Date("2026-11-23T13:05:00Z"), retryChecks: true });
      expect(asked.notes).toBeUndefined();
      expect(await getSetting(env, CHECKS_BLOCKED)).toBe("");
      expect(await ciOf(env)).toBe("pass");
      gh.calls.length = 0;
      await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst, now: () => new Date("2026-11-23T13:10:00Z") });
      expect(checkCalls(gh)).toHaveLength(2); // the cron reads check runs again, for both pull requests
    });

    it("asks again once the pause has run out", async () => {
      const env = await testEnv();
      const { gh, api } = world();
      await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst, now: () => new Date("2026-11-23T12:00:00Z") });

      // The pause runs out while no pull request is open: nothing can be asked, and the note stays.
      const pulls = api.pulls!;
      api.pulls = [];
      gh.calls.length = 0;
      const idle = await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst, now: () => new Date("2026-11-23T18:00:00.500Z") });
      expect(checkCalls(gh)).toEqual([]);
      expect(idle.notes?.[0]).toContain("GitHub refused check runs");
      expect(idle.notes?.[0]).toContain("asked again at the next poll.");
      api.pulls = pulls;
      gh.calls.length = 0;
      const r = await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst, now: () => new Date("2026-11-23T18:00:01Z") });
      expect(checkCalls(gh)).toHaveLength(1);
      expect(await getSetting(env, CHECKS_BLOCKED)).toBe("2026-11-24T00:00:01.000Z"); // refused again: paused again
      expect(r.notes).toHaveLength(1);
    });

    it("with no other source, a refusal leaves CI unknown and says why", async () => {
      const env = await testEnv();
      const { gh, api } = world();
      const head = api.branches["claude/auth-fix"].commits[0].sha;
      api.comments![7] = [comment(head)]; // present, but not a configured source
      const r = await poll(env, { fetcher: fakeFetch(gh), settings: checksOnly });
      expect(await ciOf(env)).toBe("none");
      expect(r.notes?.[0]).toContain("No other CI source is configured, so CI reads as unknown.");
      expect(gh.calls.filter((c) => c.includes("/issues/7/comments"))).toEqual([]);
    });

    it("never carries a state read on one head onto the next", async () => {
      const env = await testEnv();
      const { gh, api } = world();
      const branch = api.branches["claude/auth-fix"];
      api.checks = { [branch.commits[0].sha]: [{ name: "check", status: "completed", conclusion: "success" }] };
      await poll(env, { fetcher: fakeFetch(gh), settings: checksOnly });
      expect(await ciOf(env)).toBe("pass");

      // The head moves, and the read of CI on the new head fails.
      branch.commits.push(commit("auth: one more", ["src/services/sessionAttestation.ts"]));
      api.pushedAt = "2026-10-22T05:00:00Z";
      gh.checksError = { status: 500, message: "Server Error" };
      const r = await poll(env, { fetcher: fakeFetch(gh), settings: checksOnly });
      expect(r.errors).toHaveLength(1);
      const [b] = await getBranches(env, "cofferdamxyz/cofferdam-api");
      expect(b.head_sha).toBe(branch.commits[1].sha);
      expect(b.ci).toBe("none"); // not the old head's "pass"
    });

    it("takes only GitHub's permission answer for a refusal, and keeps what the check runs said", async () => {
      const env = await testEnv();
      const { gh, api } = world();
      const head = api.branches["claude/auth-fix"].commits[0].sha;
      api.checks = { [head]: [{ name: "check", status: "completed", conclusion: "failure" }] };
      api.comments![7] = [comment(head)]; // the comment says passed
      await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst });
      expect(await ciOf(env)).toBe("fail");

      for (const message of ["You have triggered an abuse detection mechanism. Please wait a few minutes.", "Forbidden", "Although you appear to have the correct authorization credentials, the organization has an IP allow list enabled."]) {
        gh.checksError = { status: 403, message };
        const r = await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst });
        expect(r.errors, message).toHaveLength(1);
        expect(r.notes, message).toBeUndefined();
        expect(await getSetting(env, CHECKS_BLOCKED), message).toBeNull(); // no pause
        expect(await ciOf(env), message).toBe("fail"); // and the comment's "passed" did not take over
      }
    });

    it("reads nothing for a head the pull request has already left", async () => {
      const env = await testEnv();
      const { gh, api } = world();
      const branch = api.branches["claude/auth-fix"];
      api.checks = { [branch.commits[0].sha]: [{ name: "check", status: "completed", conclusion: "success" }] };
      await poll(env, { fetcher: fakeFetch(gh), settings: checksOnly });
      expect(await ciOf(env)).toBe("pass");

      // A push lands, but the repository's `pushed_at` as this poll read it is still the old one:
      // the branch scan is skipped and the row is a head behind the pull request.
      branch.commits.push(commit("auth: one more", ["src/services/sessionAttestation.ts"]));
      gh.calls.length = 0;
      await poll(env, { fetcher: fakeFetch(gh), settings: checksOnly });
      expect(gh.calls.filter((c) => c.includes("/compare/"))).toEqual([]); // quiet: no scan
      expect(checkCalls(gh)).toEqual([]); // and no read for the commit that is no longer the head
      expect(await ciOf(env)).toBe("none");
    });

    it("does not take a rate limit for a refusal", async () => {
      const env = await testEnv();
      const { gh, api } = world();
      const head = api.branches["claude/auth-fix"].commits[0].sha;
      api.comments![7] = [comment(head)];
      gh.checksError = { status: 403, message: "API rate limit exceeded for installation ID 77." };
      const r = await poll(env, { fetcher: fakeFetch(gh), settings: checksFirst });
      expect(r.errors).toHaveLength(1); // the repository's poll failed, like any other rate-limited call
      expect(r.errors[0]).toContain("rate limit");
      expect(r.notes).toBeUndefined();
      expect(await getSetting(env, CHECKS_BLOCKED)).toBeNull();
    });

    it("is not green on a comment when the pull request has more comments than were read", async () => {
      const env = await testEnv();
      const { gh, api } = world();
      const head = api.branches["claude/auth-fix"].commits[0].sha;
      api.comments![7] = [comment(head)];
      await poll(env, { fetcher: fakeFetch(gh) });
      expect(await ciOf(env)).toBe("pass");
      api.commentsEndless = true; // a failed job's comment may sit past the third page
      gh.calls.length = 0;
      await poll(env, { fetcher: fakeFetch(gh) });
      expect(gh.calls.filter((c) => c.includes("/issues/7/comments"))).toHaveLength(3);
      expect(await ciOf(env)).toBe("pending");
    });

    it("never asks for check runs when they are not a source", async () => {
      const env = await testEnv();
      const { gh } = world();
      const r = await poll(env, { fetcher: fakeFetch(gh) }); // the fixture reads the comment only
      expect(checkCalls(gh)).toEqual([]);
      expect(r.notes).toBeUndefined();
    });
  });
});

