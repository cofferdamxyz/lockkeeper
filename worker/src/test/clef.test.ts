import { describe, expect, it } from "vitest";

import { parseDecision } from "../clef";

describe("parseDecision", () => {
  it("reads a chosen option, probabilities and scores", () => {
    const raw = {
      answers: {
        next: { choice: "b", probabilities: { a: 0.3, b: 0.6, c: 0.1 } },
        "unattended.a": 0.91,
        "unattended.b": { probability: 0.2 },
        "risk.a": 0.4,
        "risk.b": { score: 2.1 },
      },
    };
    const d = parseDecision(raw, ["a", "b", "c"]);
    expect(d.next).toBe("b");
    expect(d.unattended.a).toBeCloseTo(0.91);
    expect(d.unattended.b).toBeCloseTo(0.2);
    expect(d.risk.b).toBeCloseTo(2.1);
    expect(Number.isNaN(d.unattended.c)).toBe(true);
  });

  it("reads Clef's real answer shapes", () => {
    const raw = {
      model: "clef",
      answers: {
        next: { type: "choice", choice: "b", probabilities: { a: 0.1313, b: 0.8687 }, confidence: 0.54 },
        "unattended.a": { type: "noul", noul: 0.0254 },
        "risk.a": { type: "score", score: 0.9492, legend: { "0": "No risk" }, probabilities: { "0": 0.15, "1": 0.77 }, confidence: 0.5 },
        "unattended.b": { type: "noul", noul: 0.9754 },
        "risk.b": { type: "score", score: 0.2113 },
      },
      usage: { input_tokens: 1405, output_tokens: 0 },
    };
    const d = parseDecision(raw, ["a", "b"]);
    expect(d.next).toBe("b");
    expect(d.nextProbabilities.b).toBeCloseTo(0.8687);
    expect(d.unattended.a).toBeCloseTo(0.0254);
    expect(d.unattended.b).toBeCloseTo(0.9754);
    expect(d.risk.a).toBeCloseTo(0.9492);
  });

  it("falls back to the most probable option and rejects unknown ids", () => {
    const d = parseDecision({ answers: { next: { probabilities: { a: 0.2, b: 0.8 } } } }, ["a", "b"]);
    expect(d.next).toBe("b");
    const e = parseDecision({ answers: { next: "zzz" } }, ["a", "b"]);
    expect(e.next).toBeNull();
    expect(parseDecision(null, ["a"]).next).toBeNull();
  });
});
