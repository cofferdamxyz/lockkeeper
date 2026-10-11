/**
 * The ring layout. `main` is the innermost ring at the origin. Every branch (a task's fork) is an
 * arc on a concentric ring outside it; angle is time, so a radial line is one moment across the
 * whole history. A branch starts with a short spoke out from main at its base commit, carries its
 * commits as beads along its arc, and folds back into main with a spoke at its merge commit.
 * Rings are lanes: a merged branch frees its lane for a later branch whose arc does not overlap.
 * Files are a quiet layer below the rings, placed by the index projection.
 */
import type { MergeView, PositionView, StateView, TaskStatus, TaskView } from "./api";

export type Vec3 = [number, number, number];

export const MAIN_RADIUS = 1.5;
export const LANE_GAP = 0.55;
export const FILE_LAYER_Y = -1.3;
const SPAN = (300 * Math.PI) / 180; // the arc of the circle that time occupies; the gap marks now
const START = (120 * Math.PI) / 180; // where the oldest moment sits
const FILE_SCALE = 2.4;

export interface Bead {
  id: string;
  sha: string;
  label: string;
  at: number;
  task: string | null;
  merge: boolean;
  pos: Vec3;
  ring: number; // 0 = main
}

export interface Branch {
  task: TaskView;
  lane: number;
  radius: number;
  uStart: number;
  uEnd: number;
  live: boolean;
  mergedAt: number | null;
  tip: Vec3; // where the arc ends, on the ground
  base: Vec3; // where it left main
  mergeOnMain: Vec3 | null;
  conflict: boolean;
}

export interface RingLayout {
  tStart: number;
  tEnd: number;
  lanes: number;
  angle: (t: number) => number;
  ringPoint: (radius: number, t: number, y?: number) => Vec3;
  branches: Branch[];
  beads: Bead[];
  files: Map<string, { pos: Vec3; dir: string }>;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export function computeRings(state: StateView, now: number): RingLayout {
  const commits = state.positions.filter((p) => p.kind === "commit" && p.meta?.at);
  const times = [
    ...commits.map((c) => new Date(c.meta!.at!).getTime()),
    ...state.tasks.map((t) => new Date(t.createdAt).getTime()),
  ].filter((t) => Number.isFinite(t) && t <= now);
  const tStart = times.length ? Math.min(...times) : now - 3_600_000;
  const tEnd = now;
  const spanMs = Math.max(60_000, tEnd - tStart);
  const u = (t: number) => clamp((t - tStart) / spanMs, 0, 1);
  const angle = (t: number) => START + SPAN * u(t);
  const ringPoint = (radius: number, t: number, y = 0): Vec3 => {
    const a = angle(t);
    return [Math.cos(a) * radius, y, Math.sin(a) * radius];
  };

  // Branches: one per task, lanes allocated by start time so rings get reused.
  const mergeByTask = new Map<string, MergeView>();
  for (const m of state.merges) if (m.main_after && !mergeByTask.has(m.task_id)) mergeByTask.set(m.task_id, m);
  const conflicts = new Set(state.merges.filter((m) => m.conflict && !m.resolved_by).map((m) => m.task_id));
  const tasks = [...state.tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const laneEnds: number[] = [];
  const branches: Branch[] = [];
  for (const t of tasks) {
    const start = new Date(t.createdAt).getTime();
    if (start > now) continue;
    const merge = mergeByTask.get(t.id);
    const mergedAt = merge ? new Date(merge.at).getTime() : null;
    const live = !["merged", "abandoned", "failed"].includes(t.status) || (t.status === "merged" && mergedAt === null);
    const endT = t.status === "merged" && mergedAt !== null ? mergedAt : live ? now : new Date(t.updatedAt).getTime();
    const uStart = u(start);
    const uEnd = Math.max(uStart + 0.004, u(endT));
    let lane = laneEnds.findIndex((e) => e + 0.015 < uStart);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(uEnd);
    } else laneEnds[lane] = uEnd;
    const radius = MAIN_RADIUS + LANE_GAP * (lane + 1);
    branches.push({
      task: t,
      lane,
      radius,
      uStart,
      uEnd,
      live,
      mergedAt,
      tip: ringPoint(radius, endT),
      base: ringPoint(MAIN_RADIUS, start),
      mergeOnMain: mergedAt !== null && t.status === "merged" ? ringPoint(MAIN_RADIUS, mergedAt) : null,
      conflict: conflicts.has(t.id) && t.status === "merging",
    });
  }
  const laneOf = new Map(branches.map((b) => [b.task.id, b]));

  // Beads: commits on their branch's ring, or on main when they are merges or have no task.
  const beads: Bead[] = [];
  for (const c of commits) {
    const at = new Date(c.meta!.at!).getTime();
    if (at > now) continue;
    const task = c.meta?.task ?? null;
    const branch = task ? laneOf.get(task) : undefined;
    const onMain = c.meta?.merge || !branch;
    const radius = onMain ? MAIN_RADIUS : branch!.radius;
    beads.push({
      id: c.id,
      sha: c.meta?.sha ?? "",
      label: c.label,
      at,
      task,
      merge: !!c.meta?.merge,
      pos: ringPoint(radius, at),
      ring: onMain ? 0 : branch!.lane + 1,
    });
  }

  const files = new Map<string, { pos: Vec3; dir: string }>();
  for (const p of state.positions) {
    if (p.kind !== "file") continue;
    files.set(p.id, { pos: [p.x * FILE_SCALE, FILE_LAYER_Y, p.z * FILE_SCALE], dir: p.meta?.dir ?? "." });
  }

  return { tStart, tEnd, lanes: laneEnds.length, angle, ringPoint, branches, beads, files };
}

/** Points along an arc of a ring between two moments, for drawing. */
export function arcPoints(layout: RingLayout, radius: number, uStart: number, uEnd: number, y = 0, segments = 48): Vec3[] {
  const out: Vec3[] = [];
  const n = Math.max(2, Math.round(segments * (uEnd - uStart) * 2) + 2);
  for (let i = 0; i <= n; i++) {
    const uu = uStart + ((uEnd - uStart) * i) / n;
    const a = START + SPAN * uu;
    out.push([Math.cos(a) * radius, y, Math.sin(a) * radius]);
  }
  return out;
}

/** How far above the ground an agent floats: the distance still to go before it can merge. */
export function hoverHeight(t: TaskView, now: number): number {
  const s: TaskStatus = t.status;
  if (s === "queued") return 1.6;
  if (s === "running") {
    const minutes = (now - new Date(t.createdAt).getTime()) / 60_000;
    return Math.max(0.45, 1.5 - Math.min(1.05, minutes / 10));
  }
  if (s === "ready" || s === "approved" || s === "needs_review" || s === "blocked") return 0.25;
  if (s === "merging") return 0.12;
  return 0;
}

export function statusColor(s: TaskStatus): string {
  switch (s) {
    case "queued":
      return "#8e98a8";
    case "running":
    case "merging":
    case "approved":
      return "#1370f2";
    case "ready":
      return "#e8edf5";
    case "needs_review":
      return "#f5b94a";
    case "blocked":
      return "#c20808";
    case "failed":
      return "#ff1919";
    case "merged":
      return "#5a86c7";
    case "abandoned":
      return "#3e4654";
  }
}

export function isPositionView(p: unknown): p is PositionView {
  return !!p && typeof p === "object" && "kind" in (p as object);
}
