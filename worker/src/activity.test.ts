import { describe, expect, it } from "vitest";

import { parseActivity } from "./activity";

const lines = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I'll read the router first." }, { type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "import { Hono } ...", is_error: false }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test", description: "Run the tests" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "FAIL" }], is_error: true }] } }),
  JSON.stringify({ type: "tool_progress" }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Added the route.", total_cost_usd: 0.05, num_turns: 9, duration_ms: 120000 }),
].join("\n");

describe("parseActivity", () => {
  it("turns the stream into a compact feed", () => {
    const events = parseActivity(lines);
    expect(events.map((e) => e.kind)).toEqual(["start", "note", "tool", "result", "tool", "result", "done"]);
    expect(events[2]).toMatchObject({ kind: "tool", name: "Read", summary: "read src/index.ts", path: "src/index.ts" });
    expect(events[4]).toMatchObject({ kind: "tool", name: "Bash", summary: "Run the tests" });
    expect(events[5]).toMatchObject({ kind: "result", ok: false, text: "FAIL" });
    expect(events[6]).toMatchObject({ kind: "done", ok: true, costUsd: 0.05, turns: 9 });
  });

  it("skips malformed lines and keeps the last events", () => {
    expect(parseActivity("not json\n" + lines, 2).map((e) => e.kind)).toEqual(["result", "done"]);
  });
});
