import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Lockkeeper advises and never acts: its Wrangler config may bind nothing that could run an agent
 * or merge, and its source writes to GitHub only its token request and the advice comment. And
 * the source names no organisation: an organisation's values live in `lockkeeper.config.ts` and
 * `wrangler.jsonc` alone, so running your own never means editing code.
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

  // What this reads is one word, the name of the organisation that wrote Lockkeeper, in the files
  // a deployment runs or copies. Test fixtures and this repository's own CI workflow carry that
  // name as data and are not read here.
  it("keeps Cofferdam's name out of the source, the hook, the proxy and the examples", () => {
    const root = join(import.meta.dirname, "..", "..");
    const files = [
      ...readdirSync(dir, { recursive: true }).map(String).filter((x) => x.endsWith(".ts") && !x.includes("test/")).map((x) => join(dir, x)),
      join(root, "claude-code", "mcp-stdio.mjs"),
      join(root, "claude-code", "hooks", "lockkeeper.mjs"),
      join(root, "claude-code", "mcp.example.json"),
      join(root, "claude-code", "settings.example.json"),
      join(root, "worker", "package.json"),
      join(root, "package.json"),
    ];
    expect(files.length).toBeGreaterThan(15);
    for (const f of files) {
      // Comments count too: a comment that names a deployment's host is how a default creeps back in.
      expect(readFileSync(f, "utf8").match(/cofferdam/gi) ?? [], f).toEqual([]);
    }
  });

  it("writes no host into the hook, the proxy or the examples, and lets neither follow a redirect", () => {
    const root = join(import.meta.dirname, "..", "..");
    for (const f of ["claude-code/mcp-stdio.mjs", "claude-code/hooks/lockkeeper.mjs", "claude-code/mcp.example.json", "claude-code/settings.example.json"]) {
      const src = readFileSync(join(root, f), "utf8");
      // No network URL, no loopback, no address, and no bare host name (GitHub is named in the hook's comments on remotes).
      expect(src.match(/\b(?:https?|wss?):\/\//gi) ?? [], f).toEqual([]);
      // The loopback address is named where the scripts allow plain http on this machine only.
      expect((src.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).filter((ip) => ip !== "127.0.0.1"), f).toEqual([]);
      const hosts = (src.match(/\b(?:[a-z0-9-]+\.)+(?:xyz|com|net|org|io|dev|app|cloud|ai|co)\b/gi) ?? []).filter((h) => h.toLowerCase() !== "github.com");
      expect(hosts, f).toEqual([]);
      // Every request carries the service token, so none may be redirected to another origin.
      if (f.endsWith(".mjs")) expect((src.match(/\bfetch\(/g) ?? []).length, f).toBe((src.match(/redirect: "error"/g) ?? []).length);
    }
  });
});

