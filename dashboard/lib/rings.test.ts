import { describe, expect, it } from "vitest";

import type { StateView, TaskView } from "./api";
import { computeRings, LANE_GAP, MAIN_RADIUS } from "./rings";

const now = Date.now();
const h = (n: number) => new Date(now - n * 3_600_000).toISOString();
const task = (id: string, status: TaskView["status"], created: string, updated: string): TaskView => ({
  id, goal: id, status, fork: null, baseSha: null, headSha: null, files: [], diffstat: null, commits: [], testsOk: true, summary: null, error: null, costUsd: null, restarts: 0, resolved: false, hold: false, createdAt: created, updatedAt: updated,
});

const state: StateView = {
  project: { id: "p", repo: "p", remote: null, defaultBranch: "main", head: null, hasMap: true },
  config: { clef: { model: "clef", unattended: 0.8, unattendedAfterResolve: 0.9, maxRisk: 1, maxCandidates: 20 }, agents: { model: "m", maxMinutes: 25 } },
  snapshot: true, index: true, bootstrapStatus: null,
  tasks: [task("a", "merged", h(5), h(4)), task("b", "merged", h(3), h(2)), task("c", "running", h(1), h(0.5)), task("d", "merged", h(4.5), h(1.5))],
  positions: [
    { id: "commit:p:m1", kind: "commit", label: "merge a", x: 0, y: 0, z: 0, meta: { sha: "m1", at: h(4), task: "a", merge: true } },
    { id: "commit:p:a1", kind: "commit", label: "work a", x: 0, y: 0, z: 0, meta: { sha: "a1", at: h(4.5), task: "a", merge: false } },
    { id: "commit:p:root", kind: "commit", label: "init", x: 0, y: 0, z: 0, meta: { sha: "r0", at: h(6), task: null, merge: false } },
    { id: "file:p:x", kind: "file", label: "x.ts", x: 0.5, y: 0, z: 0.5, meta: { dir: "src" } },
  ],
  edges: [], decisions: [],
  merges: [
    { id: 1, task_id: "a", decision_id: null, mode: "unattended", main_before: "r0", main_after: "m1", conflict: 0, resolved_by: null, approved_by: null, at: h(4) },
    { id: 2, task_id: "b", decision_id: null, mode: "unattended", main_before: "m1", main_after: "m2", conflict: 0, resolved_by: null, approved_by: null, at: h(2) },
    { id: 3, task_id: "d", decision_id: null, mode: "approved", main_before: "m2", main_after: "m3", conflict: 0, resolved_by: null, approved_by: null, at: h(1.5) },
  ],
};

describe("ring layout", () => {
  it("reuses a lane once the earlier branch has merged, and keeps overlapping branches apart", () => {
    const l = computeRings(state, now);
    const lane = Object.fromEntries(l.branches.map((b) => [b.task.id, b.lane]));
    expect(lane.a).toBe(0);
    expect(lane.d).toBe(1); // overlaps a in time
    expect(lane.b).toBe(0); // a merged before b started
    expect(lane.c).toBe(0); // b merged before c started
    expect(l.lanes).toBe(2);
  });

  it("puts merge commits and task-less commits on main, branch commits on their ring", () => {
    const l = computeRings(state, now);
    const r = (p: number[]) => Math.hypot(p[0], p[2]);
    const byId = Object.fromEntries(l.beads.map((b) => [b.id, b]));
    expect(r(byId["commit:p:m1"].pos)).toBeCloseTo(MAIN_RADIUS);
    expect(r(byId["commit:p:root"].pos)).toBeCloseTo(MAIN_RADIUS);
    expect(r(byId["commit:p:a1"].pos)).toBeCloseTo(MAIN_RADIUS + LANE_GAP);
  });

  it("maps time to angle monotonically and ends a live branch at now", () => {
    const l = computeRings(state, now);
    expect(l.angle(now - 3_600_000)).toBeLessThan(l.angle(now));
    const c = l.branches.find((b) => b.task.id === "c")!;
    expect(c.live).toBe(true);
    expect(c.uEnd).toBeCloseTo(1, 2);
    expect(c.mergeOnMain).toBeNull();
  });
});
