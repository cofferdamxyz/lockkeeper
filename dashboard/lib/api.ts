// Shapes mirror worker/src/state.ts. The dashboard renders /api/state and acts through /api/tasks.

export type TaskStatus =
  | "queued" | "running" | "ready" | "merging" | "merged" | "needs_review" | "approved" | "blocked" | "failed" | "abandoned";

export interface TaskView {
  id: string;
  goal: string;
  status: TaskStatus;
  fork: string | null;
  baseSha: string | null;
  headSha: string | null;
  files: string[];
  diffstat: string | null;
  commits: string[];
  testsOk: boolean | null;
  summary: string | null;
  error: string | null;
  costUsd: number | null;
  restarts: number;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PositionView {
  id: string;
  kind: "file" | "task";
  label: string;
  x: number;
  y: number;
  z: number;
  meta: { dir?: string; bytes?: number; task?: string; status?: string } | null;
}

export interface EdgeView { a: string; b: string; cosine: number; paths: number }

export interface DecisionView {
  id: string;
  at: string;
  chosen: string | null;
  error: string | null;
  candidates: string[];
  next: Record<string, number>;
  unattended: Record<string, number | null>;
  risk: Record<string, number | null>;
}

export interface MergeView {
  id: number;
  task_id: string;
  decision_id: string | null;
  mode: string;
  main_before: string | null;
  main_after: string | null;
  conflict: number;
  resolved_by: string | null;
  approved_by: string | null;
  at: string;
}

export type ActivityEvent =
  | { kind: "start"; model?: string }
  | { kind: "note"; text: string }
  | { kind: "tool"; name: string; summary: string; path?: string }
  | { kind: "result"; ok: boolean; text: string }
  | { kind: "done"; ok: boolean; text: string; costUsd?: number; turns?: number; durationMs?: number };

export type HistoryItem =
  | { at: string; kind: "status"; task: string; status: TaskStatus }
  | { at: string; kind: "decision"; id: string; chosen: string | null; candidates: string[] }
  | { at: string; kind: "merge"; task: string; mode: string; mainAfter: string | null; conflict: boolean; resolvedBy: string | null }
  | { at: string; kind: "push"; ref: string; sha: string | null };

export interface StateView {
  project: { id: string; repo: string; remote: string | null; defaultBranch: string; head: string | null; hasMap: boolean } | null;
  config: { clef: { model: string; unattended: number; unattendedAfterResolve: number; maxRisk: number; maxCandidates: number }; agents: { model: string; maxMinutes: number } };
  snapshot: boolean;
  index: boolean;
  bootstrapStatus: string | null;
  tasks: TaskView[];
  positions: PositionView[];
  edges: EdgeView[];
  decisions: DecisionView[];
  merges: MergeView[];
}

const TOKEN_KEY = "lk_token";

/** The dashboard token arrives once as ?token=…, is kept in localStorage, and is stripped from the URL. */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("token");
    if (fromUrl) {
      window.localStorage.setItem(TOKEN_KEY, fromUrl);
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url.toString());
    }
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // private mode: the token lives for this page only
  }
}

export function projectFromUrl(): string {
  if (typeof window === "undefined") return "sample-api";
  return new URL(window.location.href).searchParams.get("project") ?? "sample-api";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function apiText(path: string): Promise<string> {
  const token = getToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  ready: "Ready",
  merging: "Merging",
  needs_review: "Needs review",
  approved: "Approved",
  merged: "Merged",
  blocked: "Blocked",
  failed: "Failed",
  abandoned: "Abandoned",
};

export const LIVE: TaskStatus[] = ["queued", "running", "ready", "merging", "approved", "needs_review", "blocked"];
export const isLive = (s: TaskStatus) => LIVE.includes(s);

/** Statuses as they were at `at`, replayed from the history, for the timeline. */
export function replayState(state: StateView, history: HistoryItem[], at: number): StateView {
  const statusAt = new Map<string, TaskStatus>();
  for (const h of history) {
    if (new Date(h.at).getTime() > at) break;
    if (h.kind === "status") statusAt.set(h.task, h.status);
  }
  const tasks = state.tasks
    .filter((t) => new Date(t.createdAt).getTime() <= at)
    .map((t) => ({ ...t, status: statusAt.get(t.id) ?? "queued" }));
  const live = new Set(tasks.filter((t) => isLive(t.status)).map((t) => t.id));
  return {
    ...state,
    tasks,
    edges: state.edges.filter((e) => live.has(e.a) && live.has(e.b)),
    merges: state.merges.filter((m) => new Date(m.at).getTime() <= at),
    decisions: state.decisions.filter((d) => new Date(d.at).getTime() <= at),
  };
}

export function elapsed(from: string, to: number = Date.now()): string {
  const s = Math.max(0, Math.round((to - new Date(from).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}
