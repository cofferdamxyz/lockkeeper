import { describe, expect, it } from "vitest";

import { buildMergeRequest, type Candidate, parseMergeDecision, RISK_LEVELS } from "./clef";

const candidate = (id: string, extra: Partial<Candidate> = {}): Candidate => ({
  id,
  goal: `goal ${id}`,
  files: ["src/index.ts"],
  diffstat: " 1 file changed, 3 insertions(+)",
  testsOk: true,
  ageMinutes: 5,
  commits: [`feat: ${id}`],
  resolved: false,
  overlaps: [],
  ...extra,
});

describe("buildMergeRequest", () => {
  it("asks one choice plus a noul and a score per candidate", () => {
    const req = buildMergeRequest([candidate("a"), candidate("b"), candidate("c")], [], "clef");
    expect(Object.keys(req.questions)).toHaveLength(1 + 3 * 2);
    expect(req.questions.next.type).toBe("choice");
    expect(Object.keys((req.questions.next as { criteria: Record<string, string> }).criteria)).toEqual(["a", "b", "c"]);
    expect(req.questions["risk.a"]).toMatchObject({ type: "score", criteria: RISK_LEVELS });
    expect(JSON.parse(req.state).ready_changes).toHaveLength(3);
  });

  it("stays under Clef's 64-question limit for 20 candidates", () => {
    const req = buildMergeRequest(Array.from({ length: 20 }, (_, i) => candidate(`t${i}`)), [], "clef");
    expect(Object.keys(req.questions).length).toBeLessThanOrEqual(64);
  });
});

describe("parseMergeDecision", () => {
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
    const d = parseMergeDecision(raw, ["a", "b", "c"]);
    expect(d.next).toBe("b");
    expect(d.unattended.a).toBeCloseTo(0.91);
    expect(d.unattended.b).toBeCloseTo(0.2);
    expect(d.risk.b).toBeCloseTo(2.1);
    expect(Number.isNaN(d.unattended.c)).toBe(true);
  });

  it("falls back to the most probable option and rejects unknown ids", () => {
    const d = parseMergeDecision({ answers: { next: { probabilities: { a: 0.2, b: 0.8 } } } }, ["a", "b"]);
    expect(d.next).toBe("b");
    const e = parseMergeDecision({ answers: { next: "zzz" } }, ["a", "b"]);
    expect(e.next).toBeNull();
    expect(parseMergeDecision(null, ["a"]).next).toBeNull();
  });
});
