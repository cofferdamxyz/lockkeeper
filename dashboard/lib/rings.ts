/**
 * The ring layout. `main` is the innermost ring at the origin. Every branch (a task's fork) is an
 * arc on a concentric ring outside it; angle is time, so a radial line is one moment across the
 * whole history. A branch starts with a short spoke out from main at its base commit, carries its
 * commits as beads along its arc, and folds back into main with a spoke at its merge commit.
 * Rings are lanes: a merged branch frees its lane for a later branch whose arc does not overlap.
 * Each branch ring is an orbital plane: it crosses main's plane along the node line through its
 * base commit, climbs to its inclination a quarter turn later and comes back down, so concurrent
 * agents ride visibly different planes. Agents hover along their plane's normal.
 * Files have no place in this space: they are attributes of commits and live in the panels.
 */
import type { MergeView, PositionView, StateView, TaskStatus, TaskView } from "./api";

export type Vec3 = [number, number, number];

export const MAIN_RADIUS = 1.5;
export const LANE_GAP = 0.55;
/** Inclinations cycle per agent so neighbouring branches never share a plane. */
export const INCLINATIONS = [22.5, -45, 67.5, -90, 45, -22.5, 90, -67.5].map((d) => (d * Math.PI) / 180);
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
  /** Angle of the node line (where the orbit crosses main's plane): the base commit's moment. */
  node: number;
  /** Tilt of the orbital plane from main's plane, in radians, signed. */
  inclination: number;
  /** Unit normal of the orbital plane. */
  normal: Vec3;
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
  /** A point on a branch's orbit at a moment. */
  orbitPoint: (b: Branch, t: number) => Vec3;
  branches: Branch[];
  beads: Bead[];
  /** Hour marks along main: a moment and its label. */
  ticks: { at: number; label: string }[];
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Rodrigues rotation of p about the unit axis k by angle θ. */
function rotate(p: Vec3, k: Vec3, theta: number): Vec3 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const kd = k[0] * p[0] + k[1] * p[1] + k[2] * p[2];
  const cross: Vec3 = [k[1] * p[2] - k[2] * p[1], k[2] * p[0] - k[0] * p[2], k[0] * p[1] - k[1] * p[0]];
  return [
    p[0] * c + cross[0] * s + k[0] * kd * (1 - c),
    p[1] * c + cross[1] * s + k[1] * kd * (1 - c),
    p[2] * c + cross[2] * s + k[2] * kd * (1 - c),
  ];
}

export function orbitPointOf(angleAt: (t: number) => number, b: Pick<Branch, "radius" | "node" | "inclination">, t: number): Vec3 {
  const a = angleAt(t);
  const flat: Vec3 = [Math.cos(a) * b.radius, 0, Math.sin(a) * b.radius];
  const axis: Vec3 = [Math.cos(b.node), 0, Math.sin(b.node)];
  return rotate(flat, axis, b.inclination);
}

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
  const commitAt = new Map(commits.map((c) => [c.meta?.sha ?? "", new Date(c.meta!.at!).getTime()]));
  let agentIndex = 0;
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
    // The orbit crosses main's plane at the base commit, so the branch lifts off from where it forked.
    const baseAtKnown = t.baseSha ? commitAt.get(t.baseSha) : undefined;
    const baseAt = baseAtKnown !== undefined && baseAtKnown <= now ? baseAtKnown : start;
    const node = angle(baseAt);
    const inclination = INCLINATIONS[agentIndex % INCLINATIONS.length];
    agentIndex += 1;
    const spec = { radius, node, inclination };
    const normal = rotate([0, 1, 0], [Math.cos(node), 0, Math.sin(node)], inclination);
    branches.push({
      task: t,
      lane,
      radius,
      node,
      inclination,
      normal,
      uStart,
      uEnd,
      live,
      mergedAt,
      tip: orbitPointOf(angle, spec, endT),
      base: ringPoint(MAIN_RADIUS, baseAt),
      mergeOnMain: mergedAt !== null && t.status === "merged" ? ringPoint(MAIN_RADIUS, mergedAt) : null,
      conflict: conflicts.has(t.id) && t.status === "merging",
      beads: [],
    });
  }
  const laneOf = new Map(branches.map((b) => [b.task.id, b]));
  const orbitPoint = (b: Branch, t: number) => orbitPointOf(angle, b, t);

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
      pos: onMain ? ringPoint(radius, at) : orbitPoint(branch!, at),
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

  return { tStart, tEnd, lanes: laneEnds.length, angle, ringPoint, orbitPoint, branches, beads, ticks };
}

/** Points along a branch's orbit between two fractions of the span, for drawing its arc. */
export function arcPoints(b: Pick<Branch, "radius" | "node" | "inclination">, uStart: number, uEnd: number, segments = 48): Vec3[] {
  const out: Vec3[] = [];
  const n = Math.max(2, Math.round(segments * (uEnd - uStart) * 2) + 2);
  const axis: Vec3 = [Math.cos(b.node), 0, Math.sin(b.node)];
  for (let i = 0; i <= n; i++) {
    const uu = uStart + ((uEnd - uStart) * i) / n;
    const a = START + SPAN * uu;
    out.push(rotate([Math.cos(a) * b.radius, 0, Math.sin(a) * b.radius], axis, b.inclination));
  }
  return out;
}

/** The whole orbit of a branch, for the faint guide ring. */
export function orbitRing(b: Pick<Branch, "radius" | "node" | "inclination">, segments = 96): Vec3[] {
  const out: Vec3[] = [];
  const axis: Vec3 = [Math.cos(b.node), 0, Math.sin(b.node)];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(rotate([Math.cos(a) * b.radius, 0, Math.sin(a) * b.radius], axis, b.inclination));
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
