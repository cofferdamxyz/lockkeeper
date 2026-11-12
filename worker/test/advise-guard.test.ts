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

  it("writes to GitHub only its token request and the advice comment", () => {
    // A tripwire on how a write is spelled here, not a proof: the client's `raw` is private, and
    // review still reads every change to this directory (it is on the sensitive list).
    for (const f of readdirSync(dir, { recursive: true }).map(String).filter((x) => x.endsWith(".ts") && !x.includes("test/"))) {
      const src = readFileSync(join(dir, f), "utf8");
      // Nothing PUTs or DELETEs on GitHub. Outside the client nothing names a write method at all.
      expect(src.match(/method:\s*["'`](PUT|DELETE)["'`]/gi) ?? [], f).toEqual([]);
      if (f !== "github.ts") {
        // No request leaves these files with a write method (the MCP server only checks its own).
        expect(src.match(/method:\s*["'`](POST|PATCH)["'`]|\?\s*["'`]POST["'`]|["'`]PATCH["'`]/gi) ?? [], f).toEqual([]);
        continue;
      }
      const writes = src.match(/"(POST|PATCH)"/g) ?? [];
      // The client: the installation token (POST), and `writeComment`, which creates (POST) or
      // edits (PATCH) one comment under /issues/. No other method reaches a write.
      expect(writes.sort()).toEqual(['"PATCH"', '"POST"', '"POST"']);
      const body = src.slice(src.indexOf("async writeComment("));
      const end = body.indexOf("\n  }\n");
      const writer = body.slice(0, end);
      expect(writer.match(/"(POST|PATCH)"/g)?.sort()).toEqual(['"PATCH"', '"POST"']);
      expect(writer).toContain("/issues/${pull}/comments");
      expect(writer).toContain("/issues/comments/${id}");
      expect(src.match(/writeComment\(/g)?.length).toBe(1);
    }
  });

  it("calls the comment writer from the advising pass alone", () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && x !== "github.ts")) {
      const src = readFileSync(join(dir, f), "utf8");
      // Twice in `syncComments`: the write, and the same write anew when the comment was deleted.
      expect((src.match(/\.writeComment\(/g) ?? []).length, f).toBe(f === "advice.ts" ? 2 : 0);
    }
  });
});
