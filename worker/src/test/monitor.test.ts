import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { advise, type Clef } from "../advice";
import { createClaim } from "../claims";
import { app } from "../index";
import { ago, h, MONITOR_HEADERS, monitorData, renderMonitor, type MonitorData } from "../monitor";
import { poll } from "../poll";
import { commit, fakeAccess, fakeFetch, resetDb, testEnv, type FakeGitHub, type FakeRepo } from "./fakes";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const EVIL = `"><script>alert(1)</script><img src=x onerror=alert(2)>\`'&`;

/** Clef picks #7 and calls both pull requests safe, so the queue has rows with numbers to draw. */
const clef: Clef = async () => ({
  answers: {
    next: { type: "choice", choice: "pr-7", probabilities: { "pr-7": 0.7, "pr-8": 0.3 } },
    "unattended.pr-7": { type: "noul", noul: 0.93 },
    "unattended.pr-8": { type: "noul", noul: 0.41 },
    "risk.pr-7": { type: "score", score: 0.2 },
    "risk.pr-8": { type: "score", score: 2.1 },
  },
});

/** Every element and attribute of the page, read by a real HTML parser. */
async function parsed(html: string): Promise<{ tags: Set<string>; attrs: Set<string>; hrefs: string[] }> {
  const tags = new Set<string>();
  const attrs = new Set<string>();
  const hrefs: string[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        tags.add(el.tagName.toLowerCase());
        for (const [name, value] of el.attributes) {
          attrs.add(name.toLowerCase());
          if (name.toLowerCase() === "href") hrefs.push(value);
        }
      },
    })
    .transform(new Response(html))
    .text();
  return { tags, attrs, hrefs };
}

async function world() {
  const env = await testEnv();
  await resetDb(env);
  const root = commit("init", ["README.md"]);
  const api: FakeRepo = {
    name: "cofferdam-api",
    pushedAt: "2026-10-22T01:00:00Z",
    main: [root],
    branches: {
      "claude/limits": { base: root.sha, commits: [commit("limits: per sender", ["src/limits.ts"])] },
      "claude/docs": { base: root.sha, commits: [{ ...commit(`docs ${EVIL}`, ["docs/a.md", `docs/${EVIL}.md`]), author: `author ${EVIL}` }] },
      [`claude/${EVIL}`]: { base: root.sha, commits: [commit("x", ["docs/a.md", `docs/${EVIL}.md`])] },
    },
    pulls: [
      { number: 7, title: "Rate limit the relay", branch: "claude/limits" },
      { number: 8, title: `A title ${EVIL}`, branch: "claude/docs", draft: true },
    ],
    comments: {},
  };
  const gh: FakeGitHub = { owner: "cofferdamxyz", repos: [api], calls: [] };
  for (const pr of api.pulls!) {
    const head = api.branches[pr.branch].commits[0].sha;
    api.comments![pr.number] = [{ body: `<!-- cofferdam-ci:check -->\n### CI ✅ passed · \`check\` on ${head.slice(0, 7)}`, user: { type: "Bot" }, updated_at: "" }];
  }
  const fetcher = fakeFetch(gh);
  await poll(env, { fetcher });
  await advise(env, { fetcher, clef });
  await createClaim(env, "hoff@cofferdam.xyz", { repo: "cofferdam-api", goal: `Claim ${EVIL}`, paths: [`src/${EVIL}.ts`], session: `session ${EVIL}` });
  return { env, gh, api };
}

const who = { who: `someone ${EVIL}`, kind: "person" } as const;

describe("the monitor page", () => {
  it("shows the queue, what is in flight, Clef's decisions and the repositories", async () => {
    const { env } = await world();
    const html = renderMonitor(await monitorData(env, who));
    for (const heading of ["Landing queue", "In flight", "Landed recently", "Clef's decisions", "Repositories"]) expect(html).toContain(`<h2>${heading}</h2>`);
    expect(html).toContain("Rate limit the relay");
    expect(html).toContain('href="https://github.com/cofferdamxyz/cofferdam-api/pull/7"');
    expect(html).toContain("claude/limits");
    expect(html).toContain("CI passed");
    expect(html).toMatch(/<b>3<\/b><span>branches in flight<\/span>/);
    expect(html).toMatch(/<b>2<\/b><span>open pull requests<\/span>/);
    expect(html).toMatch(/<b>1<\/b><span>claims<\/span>/);
    expect(html).toContain("answered"); // the decision ledger's row
    expect(html).toContain("<dt>unattended</dt><dd>0.93</dd>"); // Clef's numbers, per pull request
    expect(html).toContain("2.10 of 3, major risk");
    expect(html).toMatch(/Clef&#39;s risk 2\.10 is over 1\.00\./); // the reasons, behind their toggle
    expect(html).toMatch(/<td>#7 <span class="muted">0\.70<\/span><\/td>/); // its pick, in the ledger
    expect(html).toContain('<span class="tag">draft</span>');
  });

  it("lets nothing a pull request, a claim or an identity chose become markup", async () => {
    const { env } = await world();
    const html = renderMonitor(await monitorData(env, who));
    // The hostile text is on the page, escaped, in every place it was put.
    expect(html).toContain(h(EVIL));
    expect(html.split(h(EVIL)).length).toBeGreaterThanOrEqual(6); // whole in the title, the commit, the claim's goal and session, the identity; cut short in the branch, the author and the paths
    // And a real parser finds only the elements and attributes the renderer writes itself: no
    // script, no image, no event handler, no link anywhere but GitHub and the page itself.
    const { tags, attrs, hrefs } = await parsed(html);
    const knownTags = "html head meta title link style body main div svg polygon h1 h2 h3 p ul ol li b span nav a section article header code time dl dt dd details summary table thead tbody tr th td footer".split(" ");
    for (const t of tags) expect(knownTags, `<${t}>`).toContain(t);
    const knownAttrs = "lang charset name content http-equiv rel href class viewbox role aria-label aria-current points title datetime".split(" ");
    for (const a of attrs) expect(knownAttrs, a).toContain(a);
    expect([...attrs].filter((a) => a.startsWith("on"))).toEqual([]);
    for (const href of hrefs) expect(href).toMatch(/^(https:\/\/github\.com\/[^/]|\/(\?repo=[A-Za-z0-9._%-]+)?$|data:image\/svg\+xml,)/);
    expect(hrefs.filter((x) => x.startsWith("data:"))).toHaveLength(1); // the icon, and nothing else
  });

  it("links only to GitHub", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    const entry = (url: string) => ({ position: 1, pr: 5, title: "x", url, branch: "b", head: "a".repeat(40), draft: false, ci: "pass", ahead: 1, behind: 0, eligible: true, reasons: [], unattended: 0.9, risk: 0.1, nextP: null, label: null, issue: null, decidedAt: now.toISOString() });
    const data = (url: string): MonitorData => ({
      now, who: { who: "a@b.c", kind: "person" }, only: null, repos: [], landed: [], decisions: [], outcomes: [], poll: null, advice: null,
      present: { polledAt: null, advisedAt: null, repos: [{ repo: "o/r", defaultBranch: "main", head: null, polledAt: null, branches: [], claims: [], order: [entry(url)] }] },
    });
    for (const bad of ["javascript:alert(1)", "https://evil.example/x", "https://github.com.evil.example/x", "http://github.com/o/r/pull/5", 'https://github.com/o/r" onclick="x', "https://github.com//evil.example/x", "https://github.com/o/r/../../x", "https://github.com/o/r/pull/5\n", "//evil.example/x"]) {
      const html = renderMonitor(data(bad));
      expect(html, bad).not.toContain(`href="${h(bad)}"`);
      expect(html, bad).toContain("#5"); // still shown, as text
    }
    expect(renderMonitor(data("https://github.com/o/r/pull/5"))).toContain('<a class="pr" href="https://github.com/o/r/pull/5" rel="noreferrer noopener">#5</a>');
    for (const m of renderMonitor(data("https://github.com/o/r/pull/5")).match(/href="[^"]*"/g) ?? []) expect(m).toMatch(/^href="(https:\/\/github\.com\/[^/]|\/"|\/\?repo=|data:image\/svg\+xml,)/);
  });

  it("counts open pull requests from the poll, and says when the advice is behind", async () => {
    const env = await testEnv();
    await resetDb(env);
    const root = commit("init", ["README.md"]);
    const api: FakeRepo = { name: "cofferdam-api", pushedAt: "2026-10-22T01:00:00Z", main: [root], branches: { "claude/a": { base: root.sha, commits: [commit("a", ["a.ts"])] } }, pulls: [{ number: 3, title: "A", branch: "claude/a" }], comments: {} };
    await poll(env, { fetcher: fakeFetch({ owner: "cofferdamxyz", repos: [api], calls: [] }) }); // polled, not advised yet
    const html = renderMonitor(await monitorData(env, who));
    expect(html).not.toContain("No pull request is open");
    expect(html).toMatch(/<b>1<\/b><span>open pull requests<\/span>/);
    expect(html).toContain("1 open, 1 not advised yet");
    expect(html).toContain("Its open pull requests have no advice yet");
  });

  it("never shows a verdict as standing for a head it was not given for", async () => {
    const { env, gh, api } = await world();
    expect(renderMonitor(await monitorData(env, who))).toContain("Could land unattended"); // #7, on the head Clef saw
    api.branches["claude/limits"].commits.push(commit("limits: one more", ["src/limits.ts"]));
    api.pushedAt = "2026-10-22T02:00:00Z";
    await poll(env, { fetcher: fakeFetch(gh) }); // the head moved; the advising pass has not run
    const html = renderMonitor(await monitorData(env, who));
    expect(html).not.toContain('<span class="chip proof">Could land unattended</span>');
    expect(html).toContain("Its head moved since this advice");
    expect(html).toMatch(/<b>0<\/b><span>could land unattended<\/span>/);
  });

  it("lists what landed newest first", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    const move = (tag: string, at: string) => ({ repo: "o/r", before_sha: "x", after_sha: "y", files: [], commits: [1, 2, 3].map((i) => `${tag}${i}00000 ${tag} commit ${i}`), at });
    const html = renderMonitor({
      now, who: { who: "a@b.c", kind: "person" }, only: null, repos: [], decisions: [], outcomes: [], poll: null, advice: null,
      present: { polledAt: null, advisedAt: null, repos: [] },
      landed: [{ repo: "o/r", moves: [move("new", "2026-11-23T11:00:00Z"), move("old", "2026-11-23T09:00:00Z")] }], // newest move first, as the store returns them
    });
    const order = [...html.matchAll(/(new|old) commit (\d)/g)].map((m) => `${m[1]}${m[2]}`);
    expect(order).toEqual(["new3", "new2", "new1", "old3", "old2", "old1"]);
  });

  it("reports Clef's numbers as numbers, not as a verdict, and an empty reply as no answer", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    const base = { now, who: { who: "a@b.c", kind: "person" } as const, only: null, repos: [], landed: [], outcomes: [], poll: null, advice: null, present: { polledAt: null, advisedAt: null, repos: [] } };
    const row = (response: unknown, error: string | null = null) => ({ id: "d", repo: "o/r", candidates: ["pr-7", "pr-8"], response, error, at: now.toISOString() });
    const full = renderMonitor({ ...base, decisions: [row({ answers: { next: { choice: "pr-7", probabilities: { "pr-7": 0.7, "pr-8": 0.3 } }, "unattended.pr-7": { noul: 0.95 }, "unattended.pr-8": { noul: 0.95 }, "risk.pr-7": { score: 0.1 }, "risk.pr-8": { score: 0.1 } } })] });
    expect(full).toContain("<th>Past Clef's thresholds</th>"); // its numbers alone: the queue holds the verdict
    expect(full).not.toContain("<th>Could land unattended</th>");
    expect(full).toContain('<span class="chip ok">answered</span>');
    const empty = renderMonitor({ ...base, decisions: [row({ error: "model overloaded" })] });
    expect(empty).not.toContain('<span class="chip ok">answered</span>');
    expect(empty).toContain("answered in part");
    const part = renderMonitor({ ...base, decisions: [row({ answers: { "unattended.pr-7": { noul: 0.95 }, "risk.pr-7": { score: 0.1 } } })] });
    expect(part).toContain("answered in part");
    expect(renderMonitor({ ...base, decisions: [row(null, "Workers AI 504")] })).toContain('<span class="chip bad">failed</span>');
    // A ledger row that is not what it should be cannot break the page or write markup.
    const odd = renderMonitor({ ...base, decisions: [{ ...row(null), candidates: [] }] });
    expect(odd).toContain('<td class="n">0</td>');
  });

  it("strips characters that hide or reorder text, and names the verified identity before a claim's own label", async () => {
    expect(h("a\u202eb\u200bc\u0007d\u2066e")).toBe("abcde");
    const { env } = await world();
    await createClaim(env, "real@cofferdam.xyz", { repo: "cofferdam-api", goal: "A goal", session: "boss (boss@cofferdam.xyz), expires in 4 h\u202e" });
    const html = renderMonitor(await monitorData(env, who));
    expect(html).toContain('by real@cofferdam.xyz, session &quot;boss (boss@cofferdam.xyz), expires in 4 h&quot;');
    expect(html).not.toContain("\u202e");
  });

  it("says so when there is nothing to show", async () => {
    const env = await testEnv();
    await resetDb(env);
    const html = renderMonitor(await monitorData(env, who));
    expect(html).toContain("No pull request is open. Nothing is waiting to land.");
    expect(html).toContain("Nothing is in flight.");
    expect(html).toContain("Clef has not been asked yet.");
    expect(html).toContain("No repository has been polled yet.");
  });

  it("carries the poll's notes and errors to the top of the page", async () => {
    const { env } = await world();
    const data = await monitorData(env, who);
    const html = renderMonitor({ ...data, poll: { notes: ["GitHub refused check runs (the App needs Checks read); asked again at the next poll."], errors: [`o/r: ${EVIL}`] } });
    expect(html).toContain("GitHub refused check runs");
    expect(html).toContain("The last poll failed for one repository.");
    expect(html).not.toMatch(/<script/i);
  });

  it("shows one repository when asked, and all of them for a name it does not know", async () => {
    const { env } = await world();
    expect((await monitorData(env, who, "cofferdamxyz/cofferdam-api")).only).toBe("cofferdamxyz/cofferdam-api");
    expect((await monitorData(env, who, `cofferdamxyz/${EVIL}`)).only).toBeNull();
  });

  it("words times from the clock it is given", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    expect(ago("2026-11-23T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-11-23T11:40:00Z", now)).toBe("20 min ago");
    expect(ago("2026-11-23T02:00:00Z", now)).toBe("10 h ago");
    expect(ago("2026-11-20T12:00:00Z", now)).toBe("3 days ago");
    expect(ago("2026-11-23T12:30:00Z", now)).toBe("in 30 min");
    expect(ago(null, now)).toBe("unknown");
    expect(ago("not a date", now)).toBe("unknown");
  });
});

describe("the monitor's routes", () => {
  let call: (path: string, token?: string | null) => Promise<Response>;
  beforeEach(async () => {
    const { gh } = await world();
    const access = await fakeAccess();
    const github = fakeFetch(gh);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith("https://cofferdam.cloudflareaccess.com") ? access.fetcher(input, init) : github(input, init);
    });
    const token = await access.sign(access.claims({ email: "hoff@cofferdam.xyz" }));
    const env = await testEnv();
    call = async (path, t = token) => app.fetch(new Request(`https://lockkeeper.cofferdam.xyz${path}`, { headers: t ? { "cf-access-jwt-assertion": t } : {} }), env, ctx);
  });
  afterEach(() => vi.restoreAllMocks());

  it("answer no one without an Access assertion", async () => {
    for (const path of ["/", "/?repo=cofferdam-api", "/monitor/geist.woff2", "/monitor/geist-mono.woff2"]) {
      expect((await call(path, null)).status, path).toBe(401);
      expect((await call(path, "not.a.token")).status, path).toBe(401);
    }
  });

  it("serve the page as text that can run nothing", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    for (const [k, v] of Object.entries(MONITOR_HEADERS)) expect(res.headers.get(k), k).toBe(v);
    // Pinned word for word: loosening the policy must fail here, not pass by comparing a constant with itself.
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Signed in as hoff@cofferdam.xyz.");
    expect(html).toContain("Rate limit the relay");
    const one = await (await call("/?repo=cofferdam-api")).text();
    expect(one).toContain('<a href="/?repo=cofferdam-api" aria-current="page">cofferdam-api</a>');
  });

  it("serve the two fonts and nothing else under /monitor", async () => {
    for (const name of ["geist.woff2", "geist-mono.woff2"]) {
      const res = await call(`/monitor/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4))).toBe("wOF2");
    }
    for (const name of ["x.woff2", "__proto__", "constructor", "toString", "hasOwnProperty", "GEIST.WOFF2", "geist.woff2%2f..%2fx"]) expect((await call(`/monitor/${name}`)).status, name).toBe(404);
  });
});
