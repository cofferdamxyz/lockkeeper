// The strata city: the repository as a radial tree on the floor, time rising above it, main as
// the column at the lock. Pure functions over /api/state so the scene only draws.

import type { ActivityEvent, DecisionView, MergeView, PositionView, StateView, TaskStatus, TaskView } from "./api";

export type Vec3 = [number, number, number];

/** World height of the time window. */
export const H = 3;
export const RING_BASE = 1.45;
export const RING_GAP = 1.25;
/** Merge rings sit on the column at this radius; the lock ring at the origin is wider. */
export const COLUMN_R = 0.22;
export const LOCK_R = 0.6;
/** Vertical pitch of the candidates waiting in the lock chamber below the now ring. */
export const CHAMBER_STEP = 0.14;
export const BEACON_LIFT = 0.26;

export const CERULEAN = "#3c8aff";
export const SETTLED = "#bcd3ff";
export const RED = "#ff5d5d";
export const AMBER = "#f5b94a";
export const AGENT_COLORS = ["#5ce0b8", "#ffc857", "#b388ff", "#ff8fab", "#4fd1ff", "#ffa94d", "#c5f467", "#f7a8ff"];
const SECTOR_COLORS = ["#2f6fd6", "#27b2bf", "#6c63ff", "#8e5cf6", "#3a8fd9", "#2fa38a", "#5b7bd6", "#7c5cd6"];
const ROOT_COLOR = "#3b4a6b";

export const ringRadius = (depth: number) => RING_BASE + (depth - 1) * RING_GAP;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable accent per task, from its id. */
export function agentColor(taskId: string): string {
  return AGENT_COLORS[hash(taskId) % AGENT_COLORS.length];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
/** Mix toward white (t > 0) or black (t < 0). */
export function tint(hex: string, t: number): string {
  const [r, g, b] = hexToRgb(hex);
  const to = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  return rgbToHex(r + (to - r) * k, g + (to - g) * k, b + (to - b) * k);
}

// ---------------------------------------------------------------- ordering

/**
 * Greedy seriation: start from the best-connected key, then keep appending the unplaced key that
 * changes together with the last one most often. Keys with no co-change follow in degree order,
 * alphabetical on ties, so the result is deterministic.
 */
export function seriate(keys: string[], weight: (a: string, b: string) => number): string[] {
  if (keys.length <= 2) return [...keys].sort();
  const degree = new Map(keys.map((k) => [k, keys.reduce((s, o) => s + (o === k ? 0 : weight(k, o)), 0)]));
  const byDegree = [...keys].sort((a, b) => degree.get(b)! - degree.get(a)! || a.localeCompare(b));
  const remaining = new Set(keys);
  const out: string[] = [];
  let current = byDegree[0];
  out.push(current);
  remaining.delete(current);
  while (remaining.size > 0) {
    let best: string | null = null;
    let bestW = 0;
    for (const k of [...remaining].sort()) {
      const w = weight(current, k);
      if (w > bestW) {
        bestW = w;
        best = k;
      }
    }
    if (best === null) best = byDegree.find((k) => remaining.has(k))!;
    out.push(best);
    remaining.delete(best);
    current = best;
  }
  return out;
}

/** Co-change weights between keys, from the files each commit touched. */
export function cochange(commits: { files: string[] }[], key: (path: string) => string | null): (a: string, b: string) => number {
  const w = new Map<string, number>();
  for (const c of commits) {
    const keys = [...new Set(c.files.slice(0, 40).map(key).filter((k): k is string => k !== null))];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const id = keys[i] < keys[j] ? `${keys[i]}\n${keys[j]}` : `${keys[j]}\n${keys[i]}`;
        w.set(id, (w.get(id) ?? 0) + 1);
      }
    }
  }
  return (a, b) => w.get(a < b ? `${a}\n${b}` : `${b}\n${a}`) ?? 0;
}

// ---------------------------------------------------------------- tree + layout

interface DirNode {
  path: string;
  dirs: Map<string, DirNode>;
  files: string[];
  count: number;
}

function buildTree(paths: string[]): DirNode {
  const mk = (path: string): DirNode => ({ path, dirs: new Map(), files: [], count: 0 });
  const root = mk("");
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const path = node.path ? `${node.path}/${part}` : part;
      if (!node.dirs.has(part)) node.dirs.set(part, mk(path));
      node = node.dirs.get(part)!;
    }
    node.files.push(p);
  }
  const count = (n: DirNode): number => {
    n.count = n.files.length + [...n.dirs.values()].reduce((s, d) => s + count(d), 0);
    return n.count;
  };
  count(root);
  return root;
}

export interface CitySector {
  path: string;
  a0: number;
  a1: number;
  ringDepth: number;
  hasDirs: boolean;
  top: boolean;
  color: string;
}

export interface Placed {
  path: string;
  angle: number;
  r: number;
  slot: number;
  depth: number;
  sector: string;
  color: string;
}

/** Place every path on its ring: sectors by directory, files ordered by co-change inside each. */
export function layoutPaths(paths: string[], commits: { files: string[] }[]): { placed: Map<string, Placed>; sectors: CitySector[] } {
  const root = buildTree(paths);
  const placed = new Map<string, Placed>();
  const sectors: CitySector[] = [];
  const GAP = 0.07;
  const fileWeight = cochange(commits, (p) => p);
  const topColors = new Map<string, string>();

  const place = (node: DirNode, a0: number, a1: number, ringDepth: number, top: boolean, color: string) => {
    sectors.push({ path: node.path || "/", a0, a1, ringDepth, hasDirs: node.dirs.size > 0, top, color });
    const files = seriate(node.files, fileWeight);
    files.forEach((p, i) => {
      placed.set(p, { path: p, angle: a0 + (a1 - a0) * ((i + 0.5) / files.length), r: ringRadius(ringDepth), slot: (a1 - a0) / files.length, depth: ringDepth, sector: node.path || "/", color });
    });
    const dirs = [...node.dirs.values()];
    if (dirs.length === 0) return;
    const dirWeight = cochange(commits, (p) => {
      const d = dirs.find((x) => p.startsWith(`${x.path}/`));
      return d ? d.path : null;
    });
    const order = seriate(dirs.map((d) => d.path), dirWeight);
    const total = dirs.reduce((s, d) => s + d.count, 0);
    let b = a0;
    order.forEach((path, i) => {
      const d = dirs.find((x) => x.path === path)!;
      const span = (a1 - a0) * (d.count / total);
      const sub = top ? color : tint(color, 0.12 * ((i % 3) - 1));
      place(d, b, b + span, ringDepth + 1, false, sub);
      b += span;
    });
  };

  const dirs = [...root.dirs.values()];
  const topWeight = cochange(commits, (p) => (p.includes("/") ? p.split("/")[0] : null));
  const order = seriate(dirs.map((d) => d.path), topWeight);
  order.forEach((p, i) => topColors.set(p, SECTOR_COLORS[i % SECTOR_COLORS.length]));
  const total = root.files.length + dirs.reduce((s, d) => s + d.count, 0);
  const usable = Math.PI * 2 - GAP * (dirs.length + (root.files.length ? 1 : 0));
  let a = -Math.PI / 2 + 0.35;
  if (root.files.length > 0) {
    const span = usable * (root.files.length / total);
    place({ path: "", dirs: new Map(), files: root.files, count: root.files.length }, a, a + span, 1, true, ROOT_COLOR);
    a += span + GAP;
  }
  for (const path of order) {
    const d = dirs.find((x) => x.path === path)!;
    const span = usable * (d.count / total);
    place(d, a, a + span, 2, true, topColors.get(path)!);
    a += span + GAP;
  }
  return { placed, sectors };
}

// ---------------------------------------------------------------- the city

export interface CityFile extends Placed {
  name: string;
  x: number;
  z: number;
  width: number;
  depthR: number;
  height: number;
  bytes: number;
  /** Last change known from the commits, in ms since epoch. */
  changedAt: number | null;
  /** Touched by a live task. */
  live: boolean;
  /** Not on main yet: added by a fork in flight. */
  ghost: boolean;
  /** Removed from main inside the window. */
  deleted: boolean;
}

export interface CityCommit {
  id: string;
  sha: string;
  message: string;
  at: number;
  y: number;
  inWindow: boolean;
  files: string[];
  added: string[];
  deleted: string[];
  task: string | null;
  merge: boolean;
  live: boolean;
}

export type MergeKind = "unattended" | "resolved" | "approved";

export interface CityMerge {
  id: number;
  task: string;
  at: number;
  y: number;
  sha: string | null;
  kind: MergeKind;
  score: number | null;
  risk: number | null;
  decisionId: string | null;
}

export type BranchState = "queued" | "running" | "ready" | "merging" | "held" | "blocked" | "failed" | "merged" | "abandoned";

export interface CityBranch {
  id: string;
  task: TaskView;
  color: string;
  state: BranchState;
  live: boolean;
  commits: CityCommit[];
  files: string[];
  yStart: number;
  yEnd: number;
  merge: CityMerge | null;
}

export interface LockCandidate {
  task: TaskView;
  index: number;
  y: number;
  color: string;
  pinned: boolean;
  approved: boolean;
  score: number | null;
  risk: number | null;
  reason: string;
}

export type AgentState = "editing" | "reading" | "queued" | "ready" | "merging" | "held" | "blocked";

export interface CityAgent {
  task: TaskView;
  color: string;
  state: AgentState;
  file: string | null;
  pos: Vec3;
}

export interface CityTick {
  y: number;
  label: string;
  major: boolean;
}

export interface City {
  now: number;
  windowMs: number;
  scale: TimeScale;
  /** Height of the moment shown: the top of the window live, lower while replaying. */
  top: number;
  files: CityFile[];
  byPath: Map<string, CityFile>;
  sectors: CitySector[];
  commits: CityCommit[];
  branches: CityBranch[];
  byTask: Map<string, CityBranch>;
  merges: CityMerge[];
  lock: LockCandidate[];
  agents: CityAgent[];
  overlaps: Map<string, string[]>;
  ticks: CityTick[];
  maxRadius: number;
  yAt: (t: number) => number;
}

export const LIVE_STATUSES: TaskStatus[] = ["queued", "running", "ready", "merging", "approved", "needs_review", "blocked"];
const CANDIDATE_STATUSES: TaskStatus[] = ["approved", "merging", "ready", "needs_review"];

export function branchState(s: TaskStatus): BranchState {
  switch (s) {
    case "needs_review":
      return "held";
    case "approved":
      return "merging";
    default:
      return s;
  }
}

const MINUTE = 60_000;
const WINDOWS = [30, 60, 90, 180, 360, 720, 1440, 2880].map((m) => m * MINUTE);

// ---------------------------------------------------------------- the time scale

/** A quiet stretch longer than this folds into a short break on the column. */
export const FOLD_GAP_MS = 20 * MINUTE;
/** What a folded stretch counts as, so the break stays visible. */
export const FOLD_EFF_MS = 3 * MINUTE;
/** Room kept around any activity before a fold may start. */
export const FOLD_PAD_MS = 4 * MINUTE;

export interface Fold {
  from: number;
  to: number;
  y0: number;
  y1: number;
}

export interface TimeScale {
  now: number;
  start: number;
  folds: Fold[];
  /** Real time shown at full height. */
  busyMs: number;
  yAt: (t: number) => number;
  timeAt: (y: number) => number;
}

const clamp01 = (k: number) => Math.max(0, Math.min(1, k));

/**
 * Two-speed time: stretches with activity take the column at one rate, and quiet stretches
 * between them fold into short breaks, so the last session fills the column however long
 * ago it was. With no activity at all the scale is plain linear.
 */
export function buildTimeScale(now: number, windowMs: number, anchors: number[]): TimeScale {
  const start = now - windowMs;
  const pts = [...new Set(anchors.filter((t) => Number.isFinite(t) && t >= start && t <= now))].sort((a, b) => a - b);
  const busy: [number, number][] = [];
  for (const t of pts) {
    const a = Math.max(start, t - FOLD_PAD_MS);
    const b = Math.min(now, t + FOLD_PAD_MS);
    const last = busy[busy.length - 1];
    if (last && a - last[1] <= FOLD_GAP_MS) last[1] = Math.max(last[1], b);
    else busy.push([a, b]);
  }
  const raw: { from: number; to: number; len: number }[] = [];
  if (busy.length > 0) {
    let cursor = start;
    for (const [a, b] of busy) {
      if (a - cursor > FOLD_GAP_MS) raw.push({ from: cursor, to: a, len: a - cursor });
      cursor = Math.max(cursor, b);
    }
    if (now - cursor > FOLD_GAP_MS) raw.push({ from: cursor, to: now, len: now - cursor });
  }
  const eff = (t: number) => {
    let e = t;
    for (const f of raw) {
      if (t >= f.to) e -= f.len - FOLD_EFF_MS;
      else if (t > f.from) {
        e -= (t - f.from) * (1 - FOLD_EFF_MS / f.len);
        break;
      } else break;
    }
    return e;
  };
  const effNow = eff(now);
  const total = Math.max(1, effNow - eff(start));
  const yAt = (t: number) => H * clamp01(1 - (effNow - eff(t)) / total);
  const timeAt = (y: number) => {
    const target = effNow - (1 - clamp01(y / H)) * total;
    let removed = 0;
    for (const f of raw) {
      const effFrom = f.from - removed;
      if (target <= effFrom) break;
      if (target < effFrom + FOLD_EFF_MS) return f.from + (target - effFrom) * (f.len / FOLD_EFF_MS);
      removed += f.len - FOLD_EFF_MS;
    }
    return target + removed;
  };
  const folds: Fold[] = raw.map((f) => ({ from: f.from, to: f.to, y0: yAt(f.from), y1: yAt(f.to) }));
  return { now, start, folds, busyMs: windowMs - raw.reduce((s, f) => s + f.len, 0), yAt, timeAt };
}

/** Moments worth keeping at full height: commits, merges, task starts and ends, and now if anything is live. */
export function timeAnchors(state: StateView, now: number): number[] {
  const out: number[] = [];
  for (const p of state.positions) if (p.kind === "commit" && p.meta?.at) out.push(new Date(p.meta.at).getTime());
  for (const m of state.merges) out.push(new Date(m.at).getTime());
  for (const t of state.tasks) {
    out.push(new Date(t.createdAt).getTime(), new Date(t.updatedAt).getTime());
    if (LIVE_STATUSES.includes(t.status)) out.push(now);
  }
  return out;
}

export function durationLabel(ms: number): string {
  const m = Math.round(ms / MINUTE);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 || h >= 6 ? `${h}h` : `${h}h ${m % 60}m`;
  return `${Math.round(h / 24)}d`;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The smallest standard window that holds every live task and the last four merges, at least an hour. */
export function pickWindow(state: StateView, now: number): number {
  let oldest = now - 60 * MINUTE;
  for (const t of state.tasks) if (LIVE_STATUSES.includes(t.status)) oldest = Math.min(oldest, new Date(t.createdAt).getTime());
  const landed = state.merges.filter((m) => m.main_after).slice(0, 4);
  for (const m of landed) oldest = Math.min(oldest, new Date(m.at).getTime() - 10 * MINUTE);
  const span = now - oldest;
  return WINDOWS.find((w) => w >= span) ?? WINDOWS[WINDOWS.length - 1];
}

export function windowLabel(ms: number): string {
  const m = Math.round(ms / MINUTE);
  return m < 60 ? `${m}m` : m % 60 === 0 ? `${m / 60}h` : `${(m / 60).toFixed(1)}h`;
}

function mergeKind(m: MergeView, task: TaskView | undefined): MergeKind {
  if (m.mode === "approved" || m.approved_by) return "approved";
  if (m.resolved_by || task?.resolved) return "resolved";
  return "unattended";
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function lastPath(acts: ActivityEvent[]): { path: string; editing: boolean } | null {
  for (let i = acts.length - 1; i >= 0; i--) {
    const a = acts[i];
    if (a.kind === "tool" && a.path) {
      const path = a.path.replace(/^\/workspace\/repo\//, "").replace(/^\.\//, "");
      return { path, editing: EDIT_TOOLS.has(a.name) };
    }
  }
  return null;
}

export interface BuildOptions {
  /** Wall-clock now: the top of the window. */
  now: number;
  windowMs: number;
  activity: Record<string, ActivityEvent[]>;
  /** The moment shown while replaying; null or undefined means live. */
  at?: number | null;
  /** Moments that keep the column at full height; defaults to the state's own. */
  anchors?: number[];
}

export function buildCity(state: StateView, opts: BuildOptions): City {
  const { now, windowMs, activity } = opts;
  const scale = buildTimeScale(now, windowMs, opts.anchors ?? timeAnchors(state, now));
  const yAt = scale.yAt;
  const top = opts.at == null ? H : yAt(opts.at);
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));

  // commits
  const commits: CityCommit[] = state.positions
    .filter((p): p is PositionView & { meta: NonNullable<PositionView["meta"]> } => p.kind === "commit" && p.meta !== null && typeof p.meta.at === "string")
    .map((p) => {
      const at = new Date(p.meta.at!).getTime();
      return {
        id: p.id,
        sha: p.meta.sha ?? p.id.split(":").pop()!,
        message: p.label,
        at,
        y: yAt(at),
        inWindow: now - at <= windowMs && at <= now,
        files: p.meta.files ?? [],
        added: p.meta.added ?? [],
        deleted: p.meta.deleted ?? [],
        task: p.meta.task ?? null,
        merge: p.meta.merge === true,
        live: p.meta.live === true,
      };
    })
    .sort((a, b) => a.at - b.at);
  const bySha = new Map(commits.map((c) => [c.sha, c]));

  // files on main, plus ghosts added by forks in flight and files deleted inside the window
  const onMain = state.positions.filter((p) => p.kind === "file");
  const paths = new Set(onMain.map((p) => p.label));
  const ghosts = new Set<string>();
  const deleted = new Set<string>();
  for (const c of commits) {
    if (c.live) for (const p of c.added) if (!paths.has(p)) ghosts.add(p);
    if (!c.live && c.inWindow) for (const p of c.deleted) if (!paths.has(p)) deleted.add(p);
  }
  for (const g of ghosts) deleted.delete(g);
  const all = [...paths, ...ghosts, ...deleted];
  const { placed, sectors } = layoutPaths(all, commits);
  const bytes = new Map(onMain.map((p) => [p.label, p.meta?.bytes ?? 300]));
  const changedAt = new Map<string, number>();
  const liveFiles = new Set<string>();
  for (const c of commits) {
    for (const p of c.files) {
      changedAt.set(p, Math.max(changedAt.get(p) ?? 0, c.at));
      const t = c.task ? tasks.get(c.task) : undefined;
      if (c.live && t && LIVE_STATUSES.includes(t.status)) liveFiles.add(p);
    }
  }
  for (const t of state.tasks) if (LIVE_STATUSES.includes(t.status)) for (const p of t.files) liveFiles.add(p);
  const minLog = Math.log(100);
  const maxLog = Math.log(60_000);
  const files: CityFile[] = [];
  let maxRadius = ringRadius(2);
  for (const p of placed.values()) {
    const b = bytes.get(p.path) ?? 300;
    const f: CityFile = {
      ...p,
      name: p.path.split("/").pop()!,
      x: p.r * Math.cos(p.angle),
      z: p.r * Math.sin(p.angle),
      width: Math.min(0.3, p.r * p.slot * 0.6),
      depthR: 0.22,
      height: 0.03 + 0.26 * Math.min(1, Math.max(0, (Math.log(Math.max(1, b)) - minLog) / (maxLog - minLog))),
      bytes: b,
      changedAt: changedAt.get(p.path) ?? null,
      live: liveFiles.has(p.path),
      ghost: ghosts.has(p.path),
      deleted: deleted.has(p.path),
    };
    files.push(f);
    maxRadius = Math.max(maxRadius, p.r);
  }
  const byPath = new Map(files.map((f) => [f.path, f]));

  // merges that landed, newest first in the state; keep one per task (the latest that landed)
  const merges: CityMerge[] = [];
  const mergeByTask = new Map<string, CityMerge>();
  const decisions = new Map(state.decisions.map((d) => [d.id, d]));
  for (const m of [...state.merges].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!m.main_after) continue;
    const task = tasks.get(m.task_id);
    const commit = bySha.get(m.main_after);
    const at = commit ? commit.at : new Date(m.at).getTime();
    const d: DecisionView | undefined = m.decision_id ? decisions.get(m.decision_id) : undefined;
    const cm: CityMerge = {
      id: m.id,
      task: m.task_id,
      at,
      y: yAt(at),
      sha: m.main_after,
      kind: mergeKind(m, task),
      score: d?.unattended[m.task_id] ?? null,
      risk: d?.risk[m.task_id] ?? null,
      decisionId: m.decision_id,
    };
    merges.push(cm);
    mergeByTask.set(m.task_id, cm);
  }

  // branches: one per task, carrying its commits
  const commitsByTask = new Map<string, CityCommit[]>();
  for (const c of commits) {
    if (!c.task || c.merge) continue;
    const list = commitsByTask.get(c.task) ?? [];
    list.push(c);
    commitsByTask.set(c.task, list);
  }
  const branches: CityBranch[] = [];
  for (const t of state.tasks) {
    const own = commitsByTask.get(t.id) ?? [];
    const merge = t.status === "merged" ? (mergeByTask.get(t.id) ?? null) : null;
    const fileSet = new Set<string>(t.files);
    for (const c of own) for (const p of c.files) fileSet.add(p);
    const state_ = branchState(t.status);
    const live = LIVE_STATUSES.includes(t.status);
    const created = new Date(t.createdAt).getTime();
    const updated = new Date(t.updatedAt).getTime();
    const yStart = own.length > 0 ? Math.min(...own.map((c) => c.y)) : yAt(created);
    const yEnd = merge ? merge.y : live ? top : yAt(updated);
    if (own.length === 0 && !live && !merge) continue; // nothing to draw for an old failure without commits
    branches.push({ id: t.id, task: t, color: merge || t.status === "merged" ? SETTLED : agentColor(t.id), state: state_, live, commits: own, files: [...fileSet].filter((p) => byPath.has(p)), yStart, yEnd, merge });
  }
  const byTask = new Map(branches.map((b) => [b.id, b]));

  // the lock chamber: what waits to enter main, in the order it will
  const latestDecision = (id: string) => state.decisions.find((d) => d.candidates.includes(id));
  const candidates = state.tasks.filter((t) => CANDIDATE_STATUSES.includes(t.status));
  const rank = (t: TaskView) => (t.status === "merging" ? 0 : t.status === "approved" ? 1 : t.lockOrder !== null ? 2 : t.status === "needs_review" ? 4 : 3);
  candidates.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.lockOrder !== null && b.lockOrder !== null) return a.lockOrder - b.lockOrder;
    const da = latestDecision(a.id)?.next[a.id] ?? 0;
    const db = latestDecision(b.id)?.next[b.id] ?? 0;
    if (da !== db) return db - da;
    return a.createdAt.localeCompare(b.createdAt);
  });
  const lock: LockCandidate[] = candidates.map((t, i) => {
    const d = latestDecision(t.id);
    const score = d?.unattended[t.id] ?? null;
    const risk = d?.risk[t.id] ?? null;
    const reason =
      t.status === "merging"
        ? "merging now"
        : t.status === "approved"
          ? "approved by you"
          : t.status === "needs_review"
            ? (t.error?.startsWith("held") ? "held for review" : "needs review")
            : t.lockOrder !== null
              ? `pinned #${t.lockOrder}`
              : score === null
                ? "waiting for a decision"
                : `unattended ${score.toFixed(2)}`;
    return { task: t, index: i, y: top - CHAMBER_STEP * (i + 1), color: agentColor(t.id), pinned: t.lockOrder !== null, approved: t.status === "approved", score, risk, reason };
  });

  // agents: where each live task is right now
  const agents: CityAgent[] = [];
  const liveTasks = state.tasks.filter((t) => LIVE_STATUSES.includes(t.status));
  liveTasks.forEach((t, i) => {
    const acts = activity[t.id] ?? [];
    const last = lastPath(acts);
    const branch = byTask.get(t.id);
    let file: string | null = null;
    if (last && byPath.has(last.path)) file = last.path;
    else if (branch && branch.commits.length > 0) file = branch.commits[branch.commits.length - 1].files.find((p) => byPath.has(p)) ?? null;
    else file = t.files.find((p) => byPath.has(p)) ?? null;
    const state_: AgentState =
      t.status === "running" ? (last ? (last.editing ? "editing" : "reading") : "reading") : t.status === "queued" ? "queued" : t.status === "needs_review" ? "held" : t.status === "blocked" ? "blocked" : t.status === "merging" || t.status === "approved" ? "merging" : "ready";
    const f = file ? byPath.get(file)! : null;
    const pos: Vec3 = f
      ? [f.x, top + BEACON_LIFT, f.z]
      : [Math.cos(i * 1.3) * 0.9, top + BEACON_LIFT + 0.25 + i * 0.12, Math.sin(i * 1.3) * 0.9];
    agents.push({ task: t, color: agentColor(t.id), state: state_, file, pos });
  });

  // overlaps: a file two live tasks both touch
  const touchers = new Map<string, Set<string>>();
  for (const t of liveTasks) {
    const set = new Set<string>(t.files);
    const b = byTask.get(t.id);
    if (b) for (const p of b.files) set.add(p);
    const a = agents.find((x) => x.task.id === t.id);
    if (a?.file) set.add(a.file);
    for (const p of set) {
      if (!touchers.has(p)) touchers.set(p, new Set());
      touchers.get(p)!.add(t.id);
    }
  }
  const overlaps = new Map<string, string[]>();
  for (const [p, s] of touchers) if (s.size >= 2) overlaps.set(p, [...s]);

  // ticks up the column: clock times inside the stretches shown at full height, none inside a fold
  const ticks: CityTick[] = [];
  const step = scale.busyMs <= 180 * MINUTE ? 15 * MINUTE : scale.busyMs <= 720 * MINUTE ? 60 * MINUTE : 6 * 60 * MINUTE;
  const inFold = (t: number) => scale.folds.some((f) => t > f.from && t < f.to);
  for (let t = Math.ceil(scale.start / step) * step; t < now; t += step) {
    if (inFold(t)) continue;
    const major = step >= 60 * MINUTE || t % (60 * MINUTE) === 0;
    const label = step < 60 * MINUTE && t % (30 * MINUTE) !== 0 ? "" : clock(t);
    ticks.push({ y: yAt(t), label, major });
  }

  return { now, windowMs, scale, top, files, byPath, sectors, commits, branches, byTask, merges, lock, agents, overlaps, ticks, maxRadius, yAt };
}

// ---------------------------------------------------------------- selection

export interface Lit {
  /** Nothing picked: live work and the latest merges are lit, the rest rests. */
  rest: boolean;
  tasks: Set<string>;
  files: Set<string>;
  commits: Set<string>;
  merges: Set<number>;
}

/** What lights up for a picked id (`t-…`, `file:…`, `commit:…`, `merge:<id>`) or at rest. */
export function litFor(city: City, picked: string | null): Lit {
  const tasks = new Set<string>();
  const files = new Set<string>();
  const commits = new Set<string>();
  const merges = new Set<number>();
  const addTask = (id: string) => {
    tasks.add(id);
    const b = city.byTask.get(id);
    if (!b) return;
    for (const p of b.files) files.add(p);
    for (const c of b.commits) commits.add(c.id);
    if (b.merge) {
      merges.add(b.merge.id);
      const mc = b.merge.sha ? city.commits.find((c) => c.sha === b.merge!.sha) : undefined;
      if (mc) commits.add(mc.id);
    }
  };
  if (picked === null) {
    for (const b of city.branches) if (b.live) addTask(b.id);
    const latest = [...city.merges].sort((a, b) => b.at - a.at).slice(0, 3);
    for (const m of latest) addTask(m.task);
    return { rest: true, tasks, files, commits, merges };
  }
  if (picked.startsWith("file:")) {
    const path = picked.split(":").slice(2).join(":");
    files.add(path);
    for (const b of city.branches) if (b.files.includes(path)) addTask(b.id);
    for (const c of city.commits) if (c.files.includes(path)) commits.add(c.id);
    return { rest: false, tasks, files, commits, merges };
  }
  if (picked.startsWith("commit:")) {
    const c = city.commits.find((x) => x.id === picked);
    if (c) {
      commits.add(c.id);
      for (const p of c.files) files.add(p);
      if (c.task) addTask(c.task);
      const m = city.merges.find((x) => x.sha === c.sha);
      if (m) addTask(m.task);
    }
    return { rest: false, tasks, files, commits, merges };
  }
  if (picked.startsWith("merge:")) {
    const m = city.merges.find((x) => `merge:${x.id}` === picked);
    if (m) addTask(m.task);
    return { rest: false, tasks, files, commits, merges };
  }
  addTask(picked);
  return { rest: false, tasks, files, commits, merges };
}

// ---------------------------------------------------------------- polar routing

/** Points along the ring between two angles at one radius, the short way round. */
export function arc(a0: number, a1: number, r: number, y: number, segments = 24): Vec3[] {
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const n = Math.max(2, Math.ceil((Math.abs(d) / (Math.PI * 2)) * segments * 4));
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (d * i) / n;
    pts.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }
  return pts;
}

/** A route between two files at one height: radial to the inner ring, round it, radial out. */
export function polarRoute(from: { angle: number; r: number }, to: { angle: number; r: number }, y: number): Vec3[] {
  const inner = Math.min(from.r, to.r);
  const pts: Vec3[] = [];
  if (from.r > inner + 1e-6) pts.push([from.r * Math.cos(from.angle), y, from.r * Math.sin(from.angle)]);
  pts.push(...arc(from.angle, to.angle, inner, y));
  if (to.r > inner + 1e-6) pts.push([to.r * Math.cos(to.angle), y, to.r * Math.sin(to.angle)]);
  return pts;
}

/** Consecutive pairs for a line-segments buffer. */
export function segmentsOf(path: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i + 1 < path.length; i++) out.push(path[i], path[i + 1]);
  return out;
}

/** Index of the chamber slot a height falls into, below the ring at `top`. */
export function chamberIndex(y: number, count: number, top = H): number {
  const i = Math.round((top - CHAMBER_STEP - y) / CHAMBER_STEP);
  return Math.max(0, Math.min(Math.max(0, count - 1), i));
}

/** The moment a height on the column stands for; null means now. */
export function timeAtHeight(city: City, y: number): number | null {
  const k = Math.max(0, Math.min(1, y / H));
  if (k >= 0.985) return null;
  return city.scale.timeAt(y);
}
