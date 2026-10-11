// Pure helpers over the agent's parsed stream, so the session view only draws.
import type { ActivityEvent } from "./api";

export type Tool = Extract<ActivityEvent, { kind: "tool" }>;
export type Result = Extract<ActivityEvent, { kind: "result" }>;
export type Step = { kind: "step"; tool: Tool; result: Result | null };
export type Item = Step | Exclude<ActivityEvent, { kind: "tool" }>;

const REPO = /^\/workspace\/(repo|project)\//;
/** Outputs worth showing without a click: test counts, commit shas, errors. */
export const SIGNAL = /\b(Tests?|failed|passed|error|Error|FAIL|✓|✗|\[[0-9a-f]{7,}\]|^[0-9a-f]{7,} )/m;

/**
 * Pair each tool call with the result that follows it, keep failed results that stand alone,
 * and drop a closing note the outcome repeats word for word.
 */
export function groupEvents(events: ActivityEvent[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === "tool") {
      const next = events[i + 1];
      if (next && next.kind === "result") {
        out.push({ kind: "step", tool: e, result: next });
        i++;
      } else out.push({ kind: "step", tool: e, result: null });
    } else if (e.kind === "result") {
      if (!e.ok) out.push(e);
    } else out.push(e);
  }
  const done = out.find((x): x is Extract<ActivityEvent, { kind: "done" }> => x.kind === "done");
  if (done) {
    const idx = out.findIndex((x) => x.kind === "note" && x.text.trim() === done.text.trim());
    if (idx >= 0) out.splice(idx, 1);
  }
  return out;
}

export function shortPath(p: string | undefined): string {
  return (p ?? "").replace(REPO, "");
}

/** A shell line reads better as its first command plus a count of the rest. */
export function headline(tool: Tool): { title: string; rest: number } {
  if (tool.name === "Bash") {
    const parts = tool.summary.split(/\s*(?:;|&&|\|\|)\s*/).filter(Boolean);
    return { title: parts[0]?.slice(0, 96) ?? tool.summary, rest: Math.max(0, parts.length - 1) };
  }
  if (tool.name === "Edit" || tool.name === "MultiEdit" || tool.name === "Write") return { title: `${tool.name === "Write" ? "Wrote" : "Edited"} ${shortPath(tool.path) || "a file"}`, rest: 0 };
  if (tool.name === "Read") return { title: `Read ${shortPath(tool.path) || "a file"}`, rest: 0 };
  return { title: tool.summary.replace(REPO, ""), rest: 0 };
}
