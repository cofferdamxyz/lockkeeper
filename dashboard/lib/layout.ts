/**
 * The planes layout. The merge ring is the origin. Each directory is a plane through the origin,
 * oriented by where its files sit in the projected index. Files are projected onto their plane.
 * A commit sits on the plane of the directory it touched, or on the line where the planes of the
 * directories it touched meet, at a distance from the ring that grows with its age. Agents hover
 * above the plane they are working on and descend as they get ready.
 */
import type { PositionView, StateView, TaskStatus, TaskView } from "./api";

export type Vec3 = [number, number, number];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.sqrt(dot(a, a));
const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l < 1e-9 ? [0, 1, 0] : mul(a, 1 / l);
};
/** Project a point onto the plane through the origin with unit normal n: q − (n·q)n. */
const ontoPlane = (q: Vec3, n: Vec3): Vec3 => sub(q, mul(n, dot(n, q)));

export interface PlaneSpec {
  dir: string;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
  color: string;
  files: number;
}

export interface Layout {
  planes: PlaneSpec[];
  files: Map<string, { pos: Vec3; plane: number }>;
  commits: Map<string, { pos: Vec3; planes: number[]; ageHours: number; dir: Vec3 }>;
  tasks: Map<string, { base: Vec3; height: number; plane: number }>;
}

export const RING_RADIUS = 0.9;
const PLANE_COLORS = ["#1370f2", "#15cf53", "#ff6b3d", "#c792ea", "#ffd166", "#5ad1c9", "#ff8fa3", "#9fb4ff"];
const S = 2.4; // index units → scene units

function seededUnit(key: string): Vec3 {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const a = (h % 1000) / 1000;
  const b = ((h >>> 10) % 1000) / 1000;
  return norm([Math.cos(a * 6.283) * 0.8, 0.35 + b * 0.5, Math.sin(a * 6.283) * 0.8]);
}

/** Age in hours → distance from the ring; newest commits sit just outside it. */
export function ageRadius(ageHours: number): number {
  const a = Math.max(0, ageHours);
  return RING_RADIUS + 0.55 + 0.9 * Math.log2(1 + a);
}

export function computeLayout(state: StateView, now: number): Layout {
  const files = state.positions.filter((p) => p.kind === "file");
  const byDir = new Map<string, PositionView[]>();
  for (const f of files) {
    const d = f.meta?.dir ?? ".";
    byDir.set(d, [...(byDir.get(d) ?? []), f]);
  }
  const dirs = [...byDir.keys()].sort();
  // Each plane's azimuth comes from where its files sit in the index, then the azimuths are
  // spread evenly so no two planes lie on top of each other; the tilt stays moderate so every
  // plane reads from the default camera.
  const seeds = dirs.map((dir) => {
    const pts = byDir.get(dir)!;
    const c = pts.reduce<Vec3>((s, p) => add(s, [p.x, p.y, p.z]), [0, 0, 0]);
    const centroid = mul(c, 1 / pts.length);
    const seed = len(centroid) < 0.05 ? seededUnit(dir) : norm(centroid);
    return { dir, azimuth: Math.atan2(seed[2], seed[0]), elevation: seed[1] };
  });
  const order = [...seeds].sort((a, b) => a.azimuth - b.azimuth);
  const step = (Math.PI * 2) / Math.max(1, order.length);
  const planes: PlaneSpec[] = order.map((sd, i) => {
    const az = order.length === 1 ? sd.azimuth : i * step + step * 0.5;
    const tilt = 0.55 + 0.25 * Math.max(-1, Math.min(1, sd.elevation)); // radians from vertical
    const normal = norm([Math.cos(az) * Math.sin(tilt), Math.cos(tilt), Math.sin(az) * Math.sin(tilt)]);
    const helper: Vec3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(helper, normal));
    const v = norm(cross(normal, u));
    const idx = dirs.indexOf(sd.dir);
    return { dir: sd.dir, normal, u, v, color: PLANE_COLORS[idx % PLANE_COLORS.length], files: byDir.get(sd.dir)!.length };
  });
  const planeIndex = new Map(planes.map((p, i) => [p.dir, i]));

  const fileMap = new Map<string, { pos: Vec3; plane: number }>();
  const fileByPath = new Map<string, { pos: Vec3; plane: number }>();
  for (const f of files) {
    const pi = planeIndex.get(f.meta?.dir ?? ".") ?? 0;
    const n = planes[pi].normal;
    // Files keep their place in the index but drop onto their plane, outside the ring.
    let pos = ontoPlane(mul([f.x, f.y, f.z], S), n);
    const r = len(pos);
    const minR = RING_RADIUS + 0.9;
    if (r < minR) pos = mul(norm(r < 1e-6 ? planes[pi].u : pos), minR);
    const entry = { pos, plane: pi };
    fileMap.set(f.id, entry);
    fileByPath.set(f.label, entry);
  }

  const commits = new Map<string, { pos: Vec3; planes: number[]; ageHours: number; dir: Vec3 }>();
  for (const c of state.positions) {
    if (c.kind !== "commit") continue;
    const touched = (c.meta?.files ?? []).map((p) => fileByPath.get(p)).filter((x): x is { pos: Vec3; plane: number } => x !== undefined);
    const planesTouched = [...new Set(touched.map((t) => t.plane))];
    const at = c.meta?.at ? new Date(c.meta.at).getTime() : now;
    const ageHours = Math.max(0, now - at) / 3_600_000;
    const r = ageRadius(ageHours);
    let dir: Vec3;
    if (planesTouched.length >= 2) {
      // Where two planes meet: the line along n1 × n2, on the side of the touched files.
      const n1 = planes[planesTouched[0]].normal;
      const n2 = planes[planesTouched[1]].normal;
      const line = norm(cross(n1, n2));
      const centroid = mul(touched.reduce<Vec3>((s, t) => add(s, t.pos), [0, 0, 0]), 1 / touched.length);
      dir = dot(centroid, line) >= 0 ? line : mul(line, -1);
    } else if (planesTouched.length === 1) {
      const n = planes[planesTouched[0]].normal;
      const centroid = mul(touched.reduce<Vec3>((s, t) => add(s, t.pos), [0, 0, 0]), 1 / touched.length);
      dir = norm(ontoPlane(centroid, n));
      if (len(ontoPlane(centroid, n)) < 1e-6) dir = planes[planesTouched[0]].u;
    } else {
      // No known files: the commit's own place in the index, dropped onto the nearest plane.
      const raw = mul([c.x, c.y, c.z], S);
      let best = 0;
      let bestD = Infinity;
      planes.forEach((p, i) => {
        const d = Math.abs(dot(raw, p.normal));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const n = planes[best]?.normal ?? [0, 1, 0];
      dir = norm(ontoPlane(raw, n));
      if (len(dir) < 1e-6) dir = planes[best]?.u ?? [1, 0, 0];
      planesTouched.push(best);
    }
    commits.set(c.id, { pos: mul(dir, r), planes: planesTouched, ageHours, dir });
  }

  const tasks = new Map<string, { base: Vec3; height: number; plane: number }>();
  for (const t of state.tasks) {
    const p = state.positions.find((x) => x.kind === "task" && x.meta?.task === t.id);
    const raw: Vec3 = p ? mul([p.x, p.y, p.z], S) : [0, 0, 0];
    const touched = t.files.map((f) => fileByPath.get(f)).filter((x): x is { pos: Vec3; plane: number } => x !== undefined);
    let plane = 0;
    let base: Vec3;
    if (touched.length > 0) {
      plane = touched[0].plane;
      base = mul(touched.reduce<Vec3>((s, x) => add(s, x.pos), [0, 0, 0]), 1 / touched.length);
    } else {
      let bestD = Infinity;
      planes.forEach((pl, i) => {
        const d = Math.abs(dot(raw, pl.normal));
        if (d < bestD) {
          bestD = d;
          plane = i;
        }
      });
      base = ontoPlane(raw, planes[plane]?.normal ?? [0, 1, 0]);
    }
    if (len(base) < RING_RADIUS + 0.6) base = mul(norm(len(base) < 1e-6 ? (planes[plane]?.u ?? [1, 0, 0]) : base), RING_RADIUS + 1.6);
    tasks.set(t.id, { base, height: heightFor(t, now), plane });
  }
  return { planes, files: fileMap, commits, tasks };
}

/** How far above its plane an agent floats: the distance still to go before it can merge. */
export function heightFor(t: TaskView, now: number): number {
  const s: TaskStatus = t.status;
  if (s === "queued") return 2.4;
  if (s === "running") {
    const minutes = (now - new Date(t.createdAt).getTime()) / 60_000;
    return Math.max(0.6, 2.2 - Math.min(1.5, minutes / 10));
  }
  if (s === "ready" || s === "approved" || s === "needs_review" || s === "blocked") return 0.35;
  if (s === "merging") return 0.2;
  return 0;
}
