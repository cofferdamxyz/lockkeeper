import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Lockkeeper advises and never acts (workspace decisions 0053 and 0092): its Wrangler config may
 * bind nothing that could run an agent or merge, and its source writes to GitHub only its token
 * request and the advice comment.
 */
const dir = join(import.meta.dirname, "..", "src");

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the Worker", () => {
  it("binds no container, Artifacts, Workflow, queue, Durable Object, assets or service", () => {
    const cfg = JSON.parse(stripComments(readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8")));
    for (const key of ["containers", "artifacts", "workflows", "queues", "durable_objects", "assets", "services"]) {
      expect(cfg[key], key).toBeUndefined();
    }
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.main).toBe("src/index.ts");
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
