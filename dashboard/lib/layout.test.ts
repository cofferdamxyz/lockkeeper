import { describe, expect, it } from "vitest";

import type { StateView } from "./api";
import { ageRadius, computeLayout, RING_RADIUS } from "./layout";

const base: StateView = {
  project: { id: "p", repo: "p", remote: null, defaultBranch: "main", head: null, hasMap: true },
  config: { clef: { model: "clef", unattended: 0.8, unattendedAfterResolve: 0.9, maxRisk: 1, maxCandidates: 20 }, agents: { model: "m", maxMinutes: 25 } },
  snapshot: true,
  index: true,
  bootstrapStatus: null,
  tasks: [],
  positions: [
    { id: "file:p:src/a.ts", kind: "file", label: "src/a.ts", x: 0.6, y: 0.1, z: 0.2, meta: { dir: "src" } },
    { id: "file:p:src/b.ts", kind: "file", label: "src/b.ts", x: 0.5, y: 0.2, z: 0.1, meta: { dir: "src" } },
    { id: "file:p:test/a.test.ts", kind: "file", label: "test/a.test.ts", x: -0.5, y: 0.1, z: -0.4, meta: { dir: "test" } },
    { id: "commit:p:1", kind: "commit", label: "one", x: 0, y: 0, z: 0, meta: { sha: "1", at: new Date(Date.now() - 3_600_000).toISOString(), files: ["src/a.ts"] } },
    { id: "commit:p:2", kind: "commit", label: "two", x: 0, y: 0, z: 0, meta: { sha: "2", at: new Date(Date.now() - 48 * 3_600_000).toISOString(), files: ["src/a.ts", "test/a.test.ts"] } },
  ],
  edges: [],
  decisions: [],
  merges: [],
};

describe("planes layout", () => {
  it("makes one plane per directory and keeps files on their plane", () => {
    const l = computeLayout(base, Date.now());
    expect(l.planes.map((p) => p.dir)).toEqual(["src", "test"]);
    for (const [id, f] of l.files) {
      const n = l.planes[f.plane].normal;
      const d = f.pos[0] * n[0] + f.pos[1] * n[1] + f.pos[2] * n[2];
      expect(Math.abs(d)).toBeLessThan(1e-6);
      expect(id).toContain("file:");
    }
  });

  it("places commits by age outside the ring, straddling planes when they touch both", () => {
    const l = computeLayout(base, Date.now());
    const one = l.commits.get("commit:p:1")!;
    const two = l.commits.get("commit:p:2")!;
    const r = (p: number[]) => Math.hypot(p[0], p[1], p[2]);
    expect(r(one.pos)).toBeGreaterThan(RING_RADIUS);
    expect(r(two.pos)).toBeGreaterThan(r(one.pos));
    expect(one.planes).toEqual([0]);
    expect(two.planes.sort()).toEqual([0, 1]);
    // the straddling commit lies on both planes
    for (const pi of two.planes) {
      const n = l.planes[pi].normal;
      expect(Math.abs(two.pos[0] * n[0] + two.pos[1] * n[1] + two.pos[2] * n[2])).toBeLessThan(1e-6);
    }
    expect(ageRadius(0)).toBeCloseTo(RING_RADIUS + 0.55);
  });
});
