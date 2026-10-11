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

export const STATUS_COLOR: Record<TaskStatus, string> = {
  queued: "#7f8aa3",
  running: "#3C8AFF",
  ready: "#f2c14e",
  merging: "#ff9f43",
  needs_review: "#f2a93b",
  approved: "#ffd166",
  merged: "#2ecc71",
  blocked: "#d64fcf",
  failed: "#ff5d5d",
  abandoned: "#4b5366",
};

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

export function dirColor(dir: string | undefined): string {
  const palette = ["#5aa9ff", "#7bd389", "#ffb86b", "#c792ea", "#ff8fa3", "#5ad1c9", "#e6d36a", "#9fb4ff"];
  let h = 0;
  for (const ch of dir ?? ".") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
