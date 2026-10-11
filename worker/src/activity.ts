/**
 * Claude Code's `--output-format stream-json` is one JSON event per line. The dashboard wants
 * a compact activity feed out of it: what the agent read, edited, ran, said, and how it ended.
 */
export type ActivityEvent =
  | { kind: "start"; model?: string }
  | { kind: "note"; text: string }
  | { kind: "tool"; name: string; summary: string; path?: string }
  | { kind: "result"; ok: boolean; text: string }
  | { kind: "done"; ok: boolean; text: string; costUsd?: number; turns?: number; durationMs?: number };

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

const PATH_KEYS = ["file_path", "path", "notebook_path"];

function summarizeTool(name: string, input: Record<string, unknown> | undefined): { summary: string; path?: string } {
  const i = input ?? {};
  const path = PATH_KEYS.map((k) => i[k]).find((v) => typeof v === "string") as string | undefined;
  if (name === "Bash") {
    const d = typeof i.description === "string" ? i.description : "";
    const c = typeof i.command === "string" ? i.command : "";
    return { summary: d || c.slice(0, 160) || "shell" };
  }
  if (name === "Read") return { summary: `read ${path ?? "a file"}`, path };
  if (name === "Edit" || name === "MultiEdit") return { summary: `edit ${path ?? "a file"}`, path };
  if (name === "Write") return { summary: `write ${path ?? "a file"}`, path };
  if (name === "Grep" || name === "Glob") return { summary: `${name.toLowerCase()} ${typeof i.pattern === "string" ? i.pattern : ""}`.trim() };
  if (name === "TodoWrite") return { summary: "update the plan" };
  const keys = Object.keys(i).slice(0, 3).map((k) => `${k}=${JSON.stringify(i[k]).slice(0, 40)}`);
  return { summary: `${name.toLowerCase()} ${keys.join(" ")}`.trim(), path };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && typeof (c as Block).text === "string" ? (c as Block).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function parseActivity(raw: string, limit = 120): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; subtype?: string; model?: string; message?: { content?: Block[] | string }; is_error?: boolean; result?: string; total_cost_usd?: number; num_turns?: number; duration_ms?: number };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "system" && e.subtype === "init") out.push({ kind: "start", model: e.model });
    else if (e.type === "assistant") {
      const blocks = Array.isArray(e.message?.content) ? e.message!.content : [];
      for (const b of blocks as Block[]) {
        if (b.type === "text" && b.text?.trim()) out.push({ kind: "note", text: b.text.trim().slice(0, 600) });
        else if (b.type === "tool_use" && b.name) out.push({ kind: "tool", name: b.name, ...summarizeTool(b.name, b.input) });
      }
    } else if (e.type === "user") {
      const blocks = Array.isArray(e.message?.content) ? e.message!.content : [];
      for (const b of blocks as Block[]) {
        if (b.type === "tool_result") {
          const text = resultText(b.content).trim();
          if (b.is_error || text) out.push({ kind: "result", ok: !b.is_error, text: text.slice(0, 240) });
        }
      }
    } else if (e.type === "result") {
      out.push({ kind: "done", ok: !e.is_error, text: (e.result ?? e.subtype ?? "").slice(0, 2000), costUsd: e.total_cost_usd, turns: e.num_turns, durationMs: e.duration_ms });
    }
  }
  return out.slice(-limit);
}
