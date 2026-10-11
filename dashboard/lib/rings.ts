/**
 * The ring layout. `main` is the innermost ring at the origin. Every branch (a task's fork) is an
 * arc on a concentric ring outside it; angle is time, so a radial line is one moment across the
 * whole history. A branch starts with a short spoke out from main at its base commit, carries its
 * commits as beads along its arc, and folds back into main with a spoke at its merge commit.
 * Rings are lanes: a merged branch frees its lane for a later branch whose arc does not overlap.
 * Files have no place in this space: they are attributes of commits and live in the panels.
 */
import type { MergeView, PositionView, StateView, TaskStatus, TaskView } from "./api";

export type Vec3 = [number, number, number];

export const MAIN_RADIUS = 1.5;
export const LANE_GAP = 0.55;
const SPAN = (300 * Math.PI) / 180; // the arc of the circle that time occupies; the gap marks now
const START = (120 * Math.PI) / 180; // where the oldest moment sits

export interface Bead {
  id: string;
  sha: string;
  label: string;
  at: number;
  task: string | null;
  merge: boolean;
  files: string[];
  pos: Vec3;
  ring: number; // 0 = main
  /** 1-based order of this commit on its branch (merge beads and main commits have none). */
  seq: number | null;
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
  /** The commits on this branch, oldest first. */
  beads: Bead[];
}

export interface RingLayout {
  tStart: number;
  tEnd: number;
  lanes: number;
  angle: (t: number) => number;
  ringPoint: (radius: number, t: number, y?: number) => Vec3;
  branches: Branch[];
  beads: Bead[];
  /** Hour marks along main: a moment and its label. */
  ticks: { at: number; label: string }[];
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
      beads: [],
    });
  }
  const laneOf = new Map(branches.map((b) => [b.task.id, b]));
  // A branch leaves main at its base commit when that commit is known, else at its creation time.
  const commitAt = new Map(commits.map((c) => [c.meta?.sha ?? "", new Date(c.meta!.at!).getTime()]));
  for (const b of branches) {
    const baseAt = b.task.baseSha ? commitAt.get(b.task.baseSha) : undefined;
    if (baseAt !== undefined && baseAt <= now) b.base = ringPoint(MAIN_RADIUS, baseAt);
  }

  // Beads: commits on their branch's ring, or on main when they are merges or have no task.
  const beads: Bead[] = [];
  for (const c of commits) {
    const at = new Date(c.meta!.at!).getTime();
    if (at > now) continue;
    const task = c.meta?.task ?? null;
    const branch = task ? laneOf.get(task) : undefined;
    const onMain = c.meta?.merge || !branch;
    const radius = onMain ? MAIN_RADIUS : branch!.radius;
    const bead: Bead = {
      id: c.id,
      sha: c.meta?.sha ?? "",
      label: c.label,
      at,
      task,
      merge: !!c.meta?.merge,
      files: c.meta?.files ?? [],
      pos: ringPoint(radius, at),
      ring: onMain ? 0 : branch!.lane + 1,
      seq: null,
    };
    beads.push(bead);
    if (!onMain) branch!.beads.push(bead);
  }
  for (const b of branches) {
    b.beads.sort((x, y) => x.at - y.at);
    b.beads.forEach((bead, i) => {
      bead.seq = i + 1;
    });
  }

  // Hour marks: a readable step for the span, at most eight of them.
  const hours = spanMs / 3_600_000;
  const stepH = [0.25, 0.5, 1, 2, 3, 6, 12, 24, 48, 168].find((h) => hours / h <= 8) ?? 168;
  const ticks: { at: number; label: string }[] = [];
  const first = Math.ceil(tStart / (stepH * 3_600_000)) * stepH * 3_600_000;
  for (let t = first; t <= tEnd; t += stepH * 3_600_000) {
    const d = new Date(t);
    ticks.push({ at: t, label: stepH >= 24 ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
  }

  return { tStart, tEnd, lanes: laneEnds.length, angle, ringPoint, branches, beads, ticks };
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

/** Bead size grows a little with the number of files a commit changed. */
export function beadRadius(b: Bead): number {
  return (b.merge ? 0.095 : 0.058) + 0.01 * Math.min(6, b.files.length);
}

export function isPositionView(p: unknown): p is PositionView {
  return !!p && typeof p === "object" && "kind" in (p as object);
}
