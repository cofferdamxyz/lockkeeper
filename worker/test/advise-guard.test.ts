import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The Cofferdam deployment advises and never acts (workspace decision 0053): its entry point
 * may not reach the runner, and its Wrangler config may not bind one.
 */
const dir = join(import.meta.dirname, "..", "src", "advise");
const RUNNER = ["sandbox", "artifacts", "outbound", "workflow", "tasks", "queue", "prompt", "repomap", "live", "state", "history", "db", "lock"];

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the advisory deployment", () => {
  it("imports nothing from the runner", () => {
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/from\s+"(\.\.\/[^"]+)"/g)) {
        const target = m[1].replace(/^(\.\.\/)+/, "").replace(/\.ts$/, "");
        expect(RUNNER, `${f} imports ${m[1]}`).not.toContain(target);
      }
    }
  });

  it("binds no sandbox, Artifacts, Workflow, queue, Durable Object or assets", () => {
    const cfg = JSON.parse(stripComments(readFileSync(join(import.meta.dirname, "..", "wrangler.cofferdam.jsonc"), "utf8")));
    for (const key of ["containers", "artifacts", "workflows", "queues", "durable_objects", "assets", "services"]) {
      expect(cfg[key], key).toBeUndefined();
    }
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.main).toBe("src/advise/index.ts");
  });

  it("makes no write call to GitHub", () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      // The only POST is the installation token; nothing PUTs, PATCHes or DELETEs on GitHub.
      expect(src.match(/method: "(PUT|PATCH|DELETE)"/g) ?? [], f).toEqual([]);
      const posts = src.match(/method: "POST"/g) ?? [];
      expect(posts.length, f).toBe(f === "github.ts" ? 1 : 0);
    }
  });
});
