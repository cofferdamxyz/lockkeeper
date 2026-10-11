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
  hold: boolean;
  /** Pinned place in the lock queue; null lets Clef choose. */
  lockOrder: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PositionView {
  id: string;
  kind: "file" | "task" | "commit";
  label: string;
  x: number;
  y: number;
  z: number;
  meta: { dir?: string; bytes?: number; task?: string | null; status?: string; sha?: string; merge?: boolean; author?: string | null; files?: string[]; added?: string[]; deleted?: string[]; live?: boolean; at?: string; message?: string } | null;
}

export interface EdgeView { a: string; b: string; cosine: number; paths: number }

export interface CommitDetail {
  sha: string;
  message: string;
  body: string;
  author: string | null;
  at: string;
  parents: string[];
  files: string[];
  task: string | null;
  merge: boolean;
  position: { x: number; y: number; z: number } | null;
}

export interface FileDetail {
  path: string;
  text: string | null;
  bytes: number;
  truncated: boolean;
  commits: { sha: string; message: string; at: string; task: string | null }[];
}

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

export const STATUS_ICON: Record<TaskStatus, string> = {
  queued: "circle-dashed",
  running: "loader",
  ready: "circle-dot",
  merging: "git-merge",
  needs_review: "git-pull-request",
  approved: "git-pull-request",
  merged: "check-circle",
  blocked: "octagon-alert",
  failed: "x-circle",
  abandoned: "circle-off",
};

export function useHashRoute(): string {
  if (typeof window === "undefined") return "/";
  return window.location.hash.replace(/^#/, "") || "/";
}

export function navigate(route: string): void {
  if (typeof window === "undefined") return;
  window.location.hash = route;
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

/** Pin the lock order; an empty list hands the choice back to Clef. */
export async function setLockOrder(project: string, order: string[]): Promise<void> {
  await api(`/api/projects/${encodeURIComponent(project)}/lock`, { method: "PUT", body: JSON.stringify({ order }) });
}

export type LiveMessage = { type: "task" | "push" | "merge" | "lock" | "index"; project: string; at: string; task?: string; status?: string; mode?: string };

/**
 * Open the live feed for a project: a ticket from the Worker, then a WebSocket with it.
 * Reconnects with backoff; the caller keeps a slow poll as the fallback. Returns a stop function.
 */
export function connectLive(project: string, onMessage: (m: LiveMessage) => void, onState?: (open: boolean) => void): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: number | null = null;
  const schedule = () => {
    if (stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    attempt++;
    timer = window.setTimeout(() => void open(), delay);
  };
  const open = async () => {
    if (stopped) return;
    let path: string;
    try {
      const t = await api<{ path: string }>(`/api/live/ticket?project=${encodeURIComponent(project)}`, { method: "POST" });
      path = t.path;
    } catch {
      schedule();
      return;
    }
    const url = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${path}`;
    const ws = new WebSocket(url);
    socket = ws;
    let ping: number | null = null;
    ws.onopen = () => {
      attempt = 0;
      onState?.(true);
      ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      try {
        onMessage(JSON.parse(ev.data) as LiveMessage);
      } catch {
        // not ours
      }
    };
    ws.onclose = () => {
      if (ping !== null) window.clearInterval(ping);
      onState?.(false);
      schedule();
    };
    ws.onerror = () => ws.close();
  };
  void open();
  return () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    socket?.close();
  };
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
  const recorded = new Set(history.filter((h) => h.kind === "status").map((h) => (h as { task: string }).task));
  const tasks = state.tasks
    .filter((t) => new Date(t.createdAt).getTime() <= at)
    .map((t) => {
      // Tasks older than status recording are approximated: in flight until their last update.
      const fallback: TaskStatus = recorded.has(t.id) ? "queued" : new Date(t.updatedAt).getTime() <= at ? t.status : "running";
      return { ...t, status: statusAt.get(t.id) ?? fallback };
    });
  const commitsAt = new Set(
    state.merges.filter((m) => m.main_after && new Date(m.at).getTime() <= at).map((m) => m.task_id),
  );
  const live = new Set(tasks.filter((t) => isLive(t.status)).map((t) => t.id));
  return {
    ...state,
    tasks,
    positions: state.positions.filter((p) => {
      if (p.kind !== "commit") return true;
      if (p.meta?.at) return new Date(p.meta.at).getTime() <= at;
      return p.meta?.task ? commitsAt.has(p.meta.task) : true;
    }),
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
