import { describe, expect, it } from "vitest";

import type { StateView, TaskView } from "./api";
import { arc, buildCity, chamberIndex, cochange, H, layoutPaths, litFor, pickWindow, polarRoute, seriate, timeAtHeight } from "./city";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const task = (id: string, extra: Partial<TaskView> = {}): TaskView => ({
  id,
  goal: `goal ${id}`,
  status: "running",
  fork: `task-${id}`,
  baseSha: "base",
  headSha: null,
  files: [],
  diffstat: null,
  commits: [],
  testsOk: null,
  summary: null,
  error: null,
  costUsd: null,
  restarts: 0,
  resolved: false,
  hold: false,
  lockOrder: null,
  createdAt: ago(30),
  updatedAt: ago(1),
  ...extra,
});

const file = (path: string, bytes = 800) => ({ id: `file:p:${path}`, kind: "file" as const, label: path, x: 0, y: 0, z: 0, meta: { bytes } });
const commit = (sha: string, at: string, files: string[], task: string | null, extra: Record<string, unknown> = {}) => ({
  id: `commit:p:${sha}`,
  kind: "commit" as const,
  label: `commit ${sha}`,
  x: 0,
  y: 0,
  z: 0,
  meta: { sha, at, files, task, merge: false, ...extra },
});

function state(partial: Partial<StateView> = {}): StateView {
  return {
    project: { id: "p", repo: "p", remote: null, defaultBranch: "main", head: null, hasMap: true },
    config: { clef: { model: "clef", unattended: 0.8, unattendedAfterResolve: 0.9, maxRisk: 1, maxCandidates: 20 }, agents: { model: "m", maxMinutes: 25 } },
    snapshot: true,
    index: true,
    bootstrapStatus: null,
    tasks: [],
    positions: [],
    edges: [],
    decisions: [],
    merges: [],
    ...partial,
  };
}

describe("seriate", () => {
  it("keeps files that change together next to each other", () => {
    const w = cochange([{ files: ["a", "c"] }, { files: ["a", "c"] }, { files: ["b", "d"] }], (p) => p);
    const order = seriate(["a", "b", "c", "d"], w);
    expect(Math.abs(order.indexOf("a") - order.indexOf("c"))).toBe(1);
    expect(Math.abs(order.indexOf("b") - order.indexOf("d"))).toBe(1);
  });
  it("is deterministic without any co-change", () => {
    expect(seriate(["z", "y", "x"], () => 0)).toEqual(["x", "y", "z"]);
  });
});

describe("layoutPaths", () => {
  it("puts root files on the first ring, directories on the second, nested on the third", () => {
    const { placed, sectors } = layoutPaths(["README.md", "src/index.ts", "src/routes/ships.ts", "test/ships.test.ts"], []);
    expect(placed.get("README.md")!.depth).toBe(1);
    expect(placed.get("src/index.ts")!.depth).toBe(2);
    expect(placed.get("src/routes/ships.ts")!.depth).toBe(3);
    expect(sectors.map((s) => s.path)).toEqual(expect.arrayContaining(["/", "src", "src/routes", "test"]));
    const src = sectors.find((s) => s.path === "src")!;
    const ships = placed.get("src/routes/ships.ts")!;
    expect(ships.angle).toBeGreaterThanOrEqual(src.a0);
    expect(ships.angle).toBeLessThanOrEqual(src.a1);
  });
  it("places the test directory beside the source directory it changes with", () => {
    const commits = [{ files: ["src/a.ts", "test/a.test.ts"] }, { files: ["src/b.ts", "test/b.test.ts"] }];
    const { sectors } = layoutPaths(["docs/x.md", "src/a.ts", "src/b.ts", "test/a.test.ts", "test/b.test.ts", "lib/y.ts"], commits);
    const top = sectors.filter((s) => s.top && s.path !== "/").sort((a, b) => a.a0 - b.a0).map((s) => s.path);
    expect(Math.abs(top.indexOf("src") - top.indexOf("test"))).toBe(1);
  });
});

describe("buildCity", () => {
  const base = state({
    tasks: [
      task("t-live", { status: "running", files: ["src/a.ts"] }),
      task("t-done", { status: "merged", files: ["src/b.ts"], createdAt: ago(80), updatedAt: ago(40) }),
      task("t-wait", { status: "ready", files: ["src/c.ts"], createdAt: ago(20), updatedAt: ago(2) }),
    ],
    positions: [
      file("src/a.ts"),
      file("src/b.ts"),
      file("src/c.ts"),
      commit("l1", ago(12), ["src/a.ts"], "t-live", { live: true }),
      commit("l2", ago(5), ["src/a.ts", "src/new.ts"], "t-live", { live: true, added: ["src/new.ts"] }),
      commit("d1", ago(60), ["src/b.ts"], "t-done"),
      commit("m1", ago(40), ["src/b.ts"], "t-done", { merge: true }),
      commit("w1", ago(6), ["src/c.ts"], "t-wait", { live: true }),
    ],
    merges: [{ id: 7, task_id: "t-done", decision_id: "d-1", mode: "unattended", main_before: "x", main_after: "m1", conflict: 0, resolved_by: null, approved_by: null, at: ago(40) }],
    decisions: [{ id: "d-1", at: ago(41), chosen: "t-done", error: null, candidates: ["t-done"], next: {}, unattended: { "t-done": 0.97 }, risk: { "t-done": 0.2 } }],
  });
  const city = buildCity(base, { now: NOW, windowMs: 90 * 60_000, activity: { "t-live": [{ kind: "tool", name: "Edit", summary: "edit src/a.ts", path: "src/a.ts" }] } });

  it("maps time to height inside the window", () => {
    expect(city.yAt(NOW)).toBeCloseTo(H);
    expect(city.yAt(NOW - 45 * 60_000)).toBeCloseTo(H / 2);
    expect(city.yAt(NOW - 200 * 60_000)).toBe(0);
  });
  it("stacks a live branch from its first commit to now and a merged branch up to its merge", () => {
    const live = city.byTask.get("t-live")!;
    expect(live.commits.map((c) => c.sha)).toEqual(["l1", "l2"]);
    expect(live.yEnd).toBe(H);
    expect(live.yStart).toBeCloseTo(city.yAt(NOW - 12 * 60_000));
    const done = city.byTask.get("t-done")!;
    expect(done.merge?.kind).toBe("unattended");
    expect(done.merge?.score).toBe(0.97);
    expect(done.yEnd).toBeCloseTo(city.yAt(NOW - 40 * 60_000));
  });
  it("shows a file a fork added as a ghost until it lands", () => {
    expect(city.byPath.get("src/new.ts")?.ghost).toBe(true);
    expect(city.byPath.get("src/a.ts")?.ghost).toBe(false);
  });
  it("places the agent over the file it is editing", () => {
    const a = city.agents.find((x) => x.task.id === "t-live")!;
    expect(a.state).toBe("editing");
    expect(a.file).toBe("src/a.ts");
    expect(a.pos[1]).toBeGreaterThan(H);
  });
  it("queues the ready task in the lock chamber with its reason", () => {
    expect(city.lock.map((c) => c.task.id)).toEqual(["t-wait"]);
    expect(city.lock[0].reason).toBe("waiting for a decision");
    expect(city.lock[0].y).toBeLessThan(H);
  });
  it("flags a file two live tasks touch", () => {
    const s = state({ ...base, tasks: [task("t-1", { files: ["src/a.ts"] }), task("t-2", { files: ["src/a.ts", "src/b.ts"] })] });
    const c = buildCity(s, { now: NOW, windowMs: 90 * 60_000, activity: {} });
    expect(c.overlaps.get("src/a.ts")?.sort()).toEqual(["t-1", "t-2"]);
    expect(c.overlaps.has("src/b.ts")).toBe(false);
  });
  it("lights live work and the latest merges at rest, and one branch when picked", () => {
    const rest = litFor(city, null);
    expect(rest.rest).toBe(true);
    expect(rest.tasks.has("t-live")).toBe(true);
    expect(rest.tasks.has("t-done")).toBe(true);
    const one = litFor(city, "t-done");
    expect(one.tasks).toEqual(new Set(["t-done"]));
    expect(one.merges.has(7)).toBe(true);
    const byFile = litFor(city, "file:p:src/a.ts");
    expect(byFile.tasks.has("t-live")).toBe(true);
    expect(byFile.tasks.has("t-done")).toBe(false);
  });
});

describe("window and column helpers", () => {
  it("picks a window that holds every live task", () => {
    const s = state({ tasks: [task("t-old", { status: "running", createdAt: ago(200) })] });
    expect(pickWindow(s, NOW)).toBe(360 * 60_000);
    expect(pickWindow(state(), NOW)).toBe(60 * 60_000);
  });
  it("turns a height on the column into a moment, and the top into live", () => {
    const city = buildCity(state(), { now: NOW, windowMs: 60 * 60_000, activity: {} });
    expect(timeAtHeight(city, H)).toBeNull();
    expect(timeAtHeight(city, H / 2)).toBeCloseTo(NOW - 30 * 60_000);
  });
  it("lowers the moment shown while replaying", () => {
    const s = state({ tasks: [task("t-1", { status: "running", files: ["a.ts"] })], positions: [file("a.ts")] });
    const city = buildCity(s, { now: NOW, windowMs: 60 * 60_000, activity: {}, at: NOW - 30 * 60_000 });
    expect(city.top).toBeCloseTo(H / 2);
    expect(city.byTask.get("t-1")!.yEnd).toBeCloseTo(H / 2);
    expect(city.agents[0].pos[1]).toBeGreaterThan(H / 2);
  });
  it("maps chamber heights to slots", () => {
    expect(chamberIndex(H - 0.14, 3)).toBe(0);
    expect(chamberIndex(H - 0.42, 3)).toBe(2);
    expect(chamberIndex(-5, 3)).toBe(2);
  });
  it("routes between files round the inner ring", () => {
    const pts = polarRoute({ angle: 0, r: 2.7 }, { angle: Math.PI / 2, r: 3.95 }, 1);
    expect(pts[0]).toEqual([2.7, 1, 0]);
    expect(pts[pts.length - 1][0]).toBeCloseTo(0);
    expect(pts[pts.length - 1][2]).toBeCloseTo(3.95);
    for (const p of pts.slice(0, -1)) expect(Math.hypot(p[0], p[2])).toBeCloseTo(2.7);
    expect(arc(0, Math.PI / 2, 1, 0).length).toBeGreaterThan(5);
  });
});
