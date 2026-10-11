import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "./api";
import { groupEvents, headline } from "./activity";

describe("groupEvents", () => {
  it("pairs a tool with its result, keeps lone failures, drops the note the outcome repeats", () => {
    const events: ActivityEvent[] = [
      { kind: "start", model: "m" },
      { kind: "tool", name: "Bash", summary: "npm test" },
      { kind: "result", ok: true, text: "Tests 3 passed" },
      { kind: "result", ok: false, text: "boom" },
      { kind: "note", text: "All done." },
      { kind: "done", ok: true, text: "All done." },
    ];
    const items = groupEvents(events);
    expect(items.map((i) => i.kind)).toEqual(["start", "step", "result", "done"]);
    const step = items[1] as Extract<(typeof items)[number], { kind: "step" }>;
    expect(step.result?.text).toBe("Tests 3 passed");
  });
});

describe("headline", () => {
  it("shows the first shell command and counts the rest", () => {
    expect(headline({ kind: "tool", name: "Bash", summary: "git log | head -3; ls src && cat a.ts" })).toEqual({ title: "git log | head -3", rest: 2 });
  });
  it("names edits by their path inside the repository", () => {
    expect(headline({ kind: "tool", name: "Edit", summary: "edit x", path: "/workspace/repo/src/index.ts" })).toEqual({ title: "Edited src/index.ts", rest: 0 });
  });
});
