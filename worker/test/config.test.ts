import { describe, expect, it } from "vitest";

import config from "../../lockkeeper.config";
import { defaults, defineConfig } from "../src/config";

/**
 * The organisation's own `lockkeeper.config.ts`, as it would deploy. The Workers-pool tests run
 * against a fixture (`src/test/lockkeeper.config.fixture.ts`), so this is the one place the real
 * file is read: it must be well formed whoever's it is.
 */
describe("lockkeeper.config.ts", () => {
  it("is well formed", () => {
    expect(config.owner).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
    for (const list of [config.exclude, config.sensitive, config.ci.ignoreChecks, config.ci.requireChecks]) {
      expect(Array.isArray(list)).toBe(true);
      for (const x of list) expect(typeof x === "string" && x.trim().length > 0, String(x)).toBe(true);
    }
    // A requirement of only `*` requires nothing, and an ignore of only `*` ignores every run.
    for (const x of [...config.ci.requireChecks, ...config.ci.ignoreChecks]) expect(/^\*+$/.test(x), x).toBe(false);
    expect(config.ci.sources.length).toBeGreaterThan(0);
    for (const s of config.ci.sources) expect(["checks", "comment"]).toContain(s);
    // A comment source with an empty marker would read nothing; one that does not open an HTML comment could match prose.
    if (config.ci.sources.includes("comment")) expect(config.ci.commentMarker).toMatch(/^<!--\s*\S+/);
    if (config.issues) {
      expect(config.issues.repo).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(() => new RegExp(config.issues!.branch)).not.toThrow();
      expect(new RegExp(`${config.issues.branch}|`).exec("")!.length, "the pattern needs one group for the issue's number").toBeGreaterThan(1);
    }
    expect(config.clef.unattended).toBeGreaterThan(0.5);
    expect(config.clef.unattended).toBeLessThanOrEqual(1);
    expect(config.clef.maxRisk).toBeGreaterThanOrEqual(0);
    expect(config.clef.maxRisk).toBeLessThanOrEqual(3);
    expect(config.clef.maxCandidates).toBeGreaterThan(0);
    expect(config.clef.maxCandidates).toBeLessThanOrEqual(20); // three questions a candidate plus one, under Clef's 64
    expect(config.claims.defaultMinutes).toBeLessThanOrEqual(config.claims.maxMinutes);
    expect(config.ci.retryHours).toBeGreaterThan(0);
    expect(config.advice.retryHours).toBeGreaterThan(0);
  });

  it("keeps CI workflows sensitive, because CI is the evidence", () => {
    expect(config.sensitive).toContain("**/.github/workflows/**");
  });
});

describe("defineConfig", () => {
  it("lays an organisation's values over the defaults, one level deep", () => {
    const c = defineConfig({ owner: "acme", ci: { sources: ["checks", "comment"] }, clef: { unattended: 0.9 }, sensitive: ["api/src/auth/**"] });
    expect(c.owner).toBe("acme");
    expect(c.ci).toEqual({ ...defaults.ci, sources: ["checks", "comment"] });
    expect(c.clef).toEqual({ ...defaults.clef, unattended: 0.9 });
    expect(c.sensitive).toEqual(["api/src/auth/**"]); // a list replaces the default list
    expect(c.issues).toBeNull();
    expect(c.advice).toEqual(defaults.advice);
  });

  it("never lets an undefined replace a default, and shares nothing with the defaults", () => {
    const c = defineConfig({ owner: "acme", ci: { retryHours: undefined, requireChecks: ["test"] }, staleDays: undefined });
    expect(c.ci.retryHours).toBe(defaults.ci.retryHours);
    expect(c.staleDays).toBe(defaults.staleDays);
    c.sensitive.push("x/**");
    c.ci.sources.push("comment");
    c.clef.unattended = 0;
    expect(defaults.sensitive).toEqual(["**/.github/workflows/**"]);
    expect(defaults.ci.sources).toEqual(["checks"]);
    expect(defaults.clef.unattended).toBe(0.8);
  });

  it("starts an organisation from the safe side", () => {
    // What REVIEW.md names: CI workflows sensitive, no check ignored, nothing bound, the thresholds as shipped.
    expect(defaults.sensitive).toEqual(["**/.github/workflows/**"]);
    expect(defaults.ci).toEqual({ sources: ["checks"], requireChecks: [], ignoreChecks: [], commentMarker: "<!-- lockkeeper-ci:", retryHours: 6 });
    expect(defaults.issues).toBeNull();
    expect(defaults.claims).toEqual({ defaultMinutes: 60, maxMinutes: 240, maxLive: 50 });
    expect(defaults.clef).toEqual({ model: "clef", unattended: 0.8, maxRisk: 1.0, maxCandidates: 20 });
    expect(defaults.advice).toEqual({ comment: true, retryHours: 6, sensitiveLabel: "security" });
  });

  it("needs only an owner", () => {
    expect(defineConfig({ owner: "acme" })).toEqual({ owner: "acme", ...defaults });
  });
});

// Cofferdam's own deployment: skipped for any other organisation's configuration.
describe.skipIf(config.owner !== "cofferdamxyz")("Cofferdam's configuration", () => {
  it("keeps Lockkeeper's own source and configuration sensitive", () => {
    expect(config.sensitive).toContain("lockkeeper/worker/src/**");
    expect(config.sensitive).toContain("lockkeeper/lockkeeper.config.ts");
  });

  it("reads check runs first and its CI comment after", () => {
    expect(config.ci.sources).toEqual(["checks", "comment"]);
    expect(config.ci.commentMarker).toBe("<!-- cofferdam-ci:");
  });
});
