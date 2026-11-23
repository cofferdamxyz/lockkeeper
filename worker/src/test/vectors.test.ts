import { describe, expect, it } from "vitest";

import { cosine, jaccard } from "../vectors";

describe("overlap measures", () => {
  it("cosine and jaccard behave", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(0);
  });
});
