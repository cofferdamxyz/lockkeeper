import { describe, expect, it } from "vitest";

import { cosine, fitBasis, jaccard, project, taskText } from "./vectors";

describe("overlap measures", () => {
  it("cosine and jaccard behave", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(0);
  });
});

describe("fitBasis", () => {
  it("finds the dominant direction and keeps a fixed layout", () => {
    // Points along a line in 8 dimensions plus small noise on another axis.
    const vectors: number[][] = [];
    for (let i = 0; i < 40; i++) {
      const v = new Array<number>(8).fill(0);
      v[2] = i - 20;
      v[5] = ((i * 7919) % 13) / 13 - 0.5;
      vectors.push(v);
    }
    const basis = fitBasis(vectors);
    expect(Math.abs(basis.axes[0][2])).toBeGreaterThan(0.99);
    const [x0] = project(basis, vectors[0]);
    const [x39] = project(basis, vectors[39]);
    expect(Math.sign(x0)).not.toBe(Math.sign(x39));
    expect(Math.max(Math.abs(x0), Math.abs(x39))).toBeLessThanOrEqual(1.0001);
    // Axes are unit length and orthogonal.
    const dot = basis.axes[0].reduce((s, a, i) => s + a * basis.axes[1][i], 0);
    expect(Math.abs(dot)).toBeLessThan(1e-6);
  });
});

describe("taskText", () => {
  it("describes intention first and work once it exists", () => {
    expect(taskText({ goal: "add health" })).toBe("Goal: add health");
    expect(taskText({ goal: "add health", files: ["src/health.ts"], commits: ["feat: health"] })).toContain("Files: src/health.ts");
  });
});
