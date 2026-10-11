"use client";

import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { type ComponentRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import type { ActivityEvent, StateView } from "@/lib/api";
import {
  AMBER,
  arc,
  buildCity,
  durationLabel,
  CERULEAN,
  chamberIndex,
  CHAMBER_STEP,
  type City as CityModel,
  type CityBranch,
  type CityCommit,
  type CityFile,
  COLUMN_R,
  H,
  type Lit,
  litFor,
  LOCK_R,
  polarRoute,
  RED,
  ringRadius,
  segmentsOf,
  timeAtHeight,
  tint,
  type Vec3,
} from "@/lib/city";

export interface CityProps {
  state: StateView;
  activity: Record<string, ActivityEvent[]>;
  /** Wall-clock now. */
  now: number;
  /** The moment shown while replaying; null means live. */
  at: number | null;
  windowMs: number;
  selected: string | null;
  hovered: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  /** Dragging the now ring down the column. */
  onScrub?: (at: number | null) => void;
  /** Dragging a candidate in the lock chamber. */
  onReorder?: (order: string[]) => void;
  dark: boolean;
  focus?: string | null;
  compact?: boolean;
  /** A city built by the caller (the map view shares it with its panels). */
  city?: CityModel;
}

function palette(dark: boolean) {
  return dark
    ? { bg: "#070b16", grid: "#15203a", gridFar: "#0c1322", ring: "#34497a", sep: "#22304f", column: "#cfe3ff", settled: "#bcd3ff", mergePlate: "#e6efff", dimK: -0.62 }
    : { bg: "#f3f5fa", grid: "#d5dce9", gridFar: "#e8ecf4", ring: "#aab7d0", sep: "#c3cddf", column: "#2b3a55", settled: "#5674a8", mergePlate: "#3b5584", dimK: 0.55 };
}
type Palette = ReturnType<typeof palette>;

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Many thin lines in one draw call, a colour per segment. */
function Segments({ points, colors, opacity = 1 }: { points: Vec3[]; colors: string[]; opacity?: number }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(points.length * 3);
    const col = new Float32Array(points.length * 3);
    const c = new THREE.Color();
    for (let i = 0; i < points.length; i++) {
      pos.set(points[i], i * 3);
      c.set(colors[Math.floor(i / 2)] ?? "#ffffff");
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }, [points, colors]);
  useEffect(() => () => geo.dispose(), [geo]);
  if (points.length === 0) return null;
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial vertexColors transparent opacity={opacity} depthWrite={false} />
    </lineSegments>
  );
}

function circle(r: number, y: number, n = 128): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }
  return out;
}

/** The twelve edges of a box of the given size, centred on the origin, rotated about Y. */
function boxEdges(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, angle: number): Vec3[] {
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  const corner = (ix: number, iy: number, iz: number): Vec3 => {
    const lx = (ix - 0.5) * sx;
    const lz = (iz - 0.5) * sz;
    return [cx + lx * c + lz * s, cy + (iy - 0.5) * sy, cz - lx * s + lz * c];
  };
  const out: Vec3[] = [];
  const pairs: [number, number, number, number, number, number][] = [
    [0, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 1], [1, 0, 1, 0, 0, 1], [0, 0, 1, 0, 0, 0],
    [0, 1, 0, 1, 1, 0], [1, 1, 0, 1, 1, 1], [1, 1, 1, 0, 1, 1], [0, 1, 1, 0, 1, 0],
    [0, 0, 0, 0, 1, 0], [1, 0, 0, 1, 1, 0], [1, 0, 1, 1, 1, 1], [0, 0, 1, 0, 1, 1],
  ];
  for (const [ax, ay, az, bx, by, bz] of pairs) out.push(corner(ax, ay, az), corner(bx, by, bz));
  return out;
}

// ---------------------------------------------------------------- floor

function Floor({ city, p, compact }: { city: CityModel; p: Palette; compact: boolean }) {
  const { points, colors } = useMemo(() => {
    const points: Vec3[] = [];
    const colors: string[] = [];
    const half = Math.ceil(city.maxRadius + 6);
    for (let i = -half; i <= half; i++) {
      const t = Math.min(1, Math.abs(i) / half);
      const c = tint(p.grid, (p.dimK < 0 ? -1 : 1) * t * 0.5);
      points.push([i, -0.004, -half], [i, -0.004, half], [-half, -0.004, i], [half, -0.004, i]);
      colors.push(c, c);
    }
    const depths = Math.max(2, Math.round((city.maxRadius - ringRadius(1)) / (ringRadius(2) - ringRadius(1)) + 1));
    for (let d = 1; d <= depths; d++) {
      const seg = segmentsOf(circle(ringRadius(d), 0.002));
      points.push(...seg);
      for (let i = 0; i < seg.length / 2; i++) colors.push(p.ring);
    }
    for (const s of city.sectors.filter((x) => x.top)) {
      for (const a of [s.a0, s.a1]) {
        points.push([0.95 * Math.cos(a), 0.002, 0.95 * Math.sin(a)], [(city.maxRadius + 0.8) * Math.cos(a), 0.002, (city.maxRadius + 0.8) * Math.sin(a)]);
        colors.push(p.sep);
      }
    }
    return { points, colors };
  }, [city.maxRadius, city.sectors, p]);
  const labels = useMemo(() => {
    // Narrow sub-sectors would print over their neighbours; their parent's label carries them.
    const all = city.sectors.filter((s) => (compact ? s.top : s.top || s.a1 - s.a0 > 0.16));
    return (all.length > 28 ? all.filter((s) => s.top) : all).map((s) => {
      const mid = (s.a0 + s.a1) / 2;
      const rr = s.hasDirs ? ringRadius(s.ringDepth) - 0.62 : ringRadius(s.ringDepth) + (s.path === "/" ? 0.85 : 0.62);
      return { key: s.path, pos: [rr * Math.cos(mid), 0.02, rr * Math.sin(mid)] as Vec3, text: s.path === "/" ? "root" : s.path };
    });
  }, [city.sectors, compact]);
  return (
    <>
      <Segments points={points} colors={colors} />
      {labels.map((l) => (
        <Html key={l.key} position={l.pos} center distanceFactor={12} style={{ pointerEvents: "none" }}>
          <div className="scene-dir">{l.text}</div>
        </Html>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- files

function blockColor(f: CityFile, city: CityModel, lit: Lit, dark: boolean): string {
  const base = f.color;
  const isLit = lit.files.has(f.path);
  if (!lit.rest && !isLit) return tint(base, dark ? -0.6 : 0.55);
  if (f.live) return tint(base, 0.38);
  if (isLit && !lit.rest) return tint(base, 0.3);
  const recent = f.changedAt !== null ? Math.max(0, 1 - (city.now - f.changedAt) / city.windowMs) : 0;
  if (recent > 0) return tint(base, 0.06 + 0.26 * recent);
  return tint(base, dark ? -0.38 : 0.1);
}

function BlockSet({ files, city, lit, dark, opacity, project, onSelect, onHover }: { files: CityFile[]; city: CityModel; lit: Lit; dark: boolean; opacity: number; project: string; onSelect: (id: string) => void; onHover: (id: string | null) => void }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const c = new THREE.Color();
    files.forEach((f, i) => {
      q.setFromAxisAngle(Y_AXIS, -f.angle);
      pos.set(f.x, f.height / 2, f.z);
      scl.set(f.depthR, f.height, f.width);
      mat.compose(pos, q, scl);
      m.setMatrixAt(i, mat);
      c.set(blockColor(f, city, lit, dark));
      m.setColorAt(i, c);
    });
    m.count = files.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [files, city, lit, dark]);
  const edges = useMemo(() => {
    const points: Vec3[] = [];
    const colors: string[] = [];
    for (const f of files) {
      const seg = boxEdges(f.x, f.height / 2, f.z, f.depthR, f.height, f.width, f.angle);
      points.push(...seg);
      const isLit = lit.files.has(f.path) || (lit.rest && (f.live || f.changedAt !== null));
      const c = isLit ? tint(f.color, 0.45) : tint(f.color, dark ? -0.2 : 0.3);
      for (let i = 0; i < 12; i++) colors.push(c);
    }
    return { points, colors };
  }, [files, lit, dark]);
  if (files.length === 0) return null;
  return (
    <>
      <instancedMesh
        key={files.length}
        ref={ref}
        args={[undefined, undefined, files.length]}
        onClick={(e) => {
          e.stopPropagation();
          const f = files[e.instanceId ?? -1];
          if (f) onSelect(`file:${project}:${f.path}`);
        }}
        onPointerMove={(e) => {
          e.stopPropagation();
          const f = files[e.instanceId ?? -1];
          onHover(f ? `file:${project}:${f.path}` : null);
        }}
        onPointerOut={() => onHover(null)}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshPhongMaterial transparent={opacity < 1} opacity={opacity} shininess={40} specular="#30405f" depthWrite={opacity >= 1} />
      </instancedMesh>
      <Segments points={edges.points} colors={edges.colors} opacity={opacity < 1 ? 0.5 : 0.85} />
    </>
  );
}

function Blocks(props: { city: CityModel; lit: Lit; dark: boolean; project: string; onSelect: (id: string) => void; onHover: (id: string | null) => void }) {
  const solid = useMemo(() => props.city.files.filter((f) => !f.ghost && !f.deleted), [props.city.files]);
  const ghosts = useMemo(() => props.city.files.filter((f) => f.ghost || f.deleted), [props.city.files]);
  return (
    <>
      <BlockSet {...props} files={solid} opacity={1} />
      <BlockSet {...props} files={ghosts} opacity={0.3} />
    </>
  );
}

// ---------------------------------------------------------------- commits

interface Plate {
  key: string;
  id: string;
  commit: CityCommit | null;
  file: CityFile;
  y: number;
  offset: number;
  color: string;
  merge: boolean;
  branch: CityBranch;
}

function platesOf(city: CityModel, p: Palette): Plate[] {
  const out: Plate[] = [];
  // Live branches sharing a file sit side by side, so both chains stay readable.
  const sharers = new Map<string, string[]>();
  for (const b of city.branches) if (b.live) for (const f of b.files) sharers.set(f, [...(sharers.get(f) ?? []), b.id]);
  const offsetOf = (file: string, branch: string) => {
    const s = sharers.get(file) ?? [];
    const i = s.indexOf(branch);
    return s.length > 1 && i >= 0 ? (i - (s.length - 1) / 2) * 0.07 : 0;
  };
  for (const b of city.branches) {
    for (const c of b.commits) {
      if (!c.inWindow) continue;
      for (const path of c.files) {
        const f = city.byPath.get(path);
        if (f) out.push({ key: `${c.id}|${path}`, id: c.id, commit: c, file: f, y: c.y, offset: offsetOf(path, b.id), color: b.color, merge: false, branch: b });
      }
    }
    if (b.merge && b.merge.y > 0) {
      const mc = city.commits.find((x) => x.sha === b.merge!.sha) ?? null;
      for (const path of b.files) {
        const f = city.byPath.get(path);
        if (f) out.push({ key: `merge:${b.merge.id}|${path}`, id: mc?.id ?? `merge:${b.merge.id}`, commit: mc, file: f, y: b.merge.y, offset: 0, color: p.mergePlate, merge: true, branch: b });
      }
    }
  }
  return out;
}

function Plates({ city, lit, p, dark, onSelect, onHover }: { city: CityModel; lit: Lit; p: Palette; dark: boolean; onSelect: (id: string) => void; onHover: (id: string | null) => void }) {
  const plates = useMemo(() => platesOf(city, p), [city, p]);
  const ref = useRef<THREE.InstancedMesh>(null);
  const born = useRef(new Map<string, number>());
  const clock = useRef(0);
  const animating = useRef(new Set<number>());
  const isLit = (pl: Plate) => (pl.commit ? lit.commits.has(pl.commit.id) : lit.merges.has(pl.branch.merge?.id ?? -1)) || lit.tasks.has(pl.branch.id);
  const place = (m: THREE.InstancedMesh, i: number, pl: Plate, k: number) => {
    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, -pl.file.angle);
    const tx = -Math.sin(pl.file.angle) * pl.offset;
    const tz = Math.cos(pl.file.angle) * pl.offset;
    const pos = new THREE.Vector3(pl.file.x + tx, pl.y, pl.file.z + tz);
    const s = pl.merge ? 0.86 : 0.74;
    const scl = new THREE.Vector3(pl.file.depthR * s * k, 0.03, pl.file.width * s * k);
    mat.compose(pos, q, scl);
    m.setMatrixAt(i, mat);
  };
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const c = new THREE.Color();
    const seen = new Set<string>();
    plates.forEach((pl, i) => {
      seen.add(pl.key);
      let k = 1;
      if (!born.current.has(pl.key)) {
        born.current.set(pl.key, clock.current);
        animating.current.add(i);
        k = 0.01;
      }
      place(m, i, pl, k);
      const lit_ = isLit(pl);
      c.set(lit_ ? pl.color : tint(pl.color, dark ? -0.62 : 0.5));
      m.setColorAt(i, c);
    });
    for (const key of [...born.current.keys()]) if (!seen.has(key)) born.current.delete(key);
    m.count = plates.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [plates, lit, dark]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(({ clock: cl }) => {
    clock.current = cl.elapsedTime;
    const m = ref.current;
    if (!m || animating.current.size === 0) return;
    for (const i of [...animating.current]) {
      const pl = plates[i];
      if (!pl) {
        animating.current.delete(i);
        continue;
      }
      const t = Math.min(1, (cl.elapsedTime - (born.current.get(pl.key) ?? cl.elapsedTime)) / 0.7);
      const k = 1 - Math.pow(1 - t, 3);
      place(m, i, pl, Math.max(0.01, k));
      if (t >= 1) animating.current.delete(i);
    }
    m.instanceMatrix.needsUpdate = true;
  });
  const edges = useMemo(() => {
    const points: Vec3[] = [];
    const colors: string[] = [];
    for (const pl of plates) {
      const s = pl.merge ? 0.86 : 0.74;
      const tx = -Math.sin(pl.file.angle) * pl.offset;
      const tz = Math.cos(pl.file.angle) * pl.offset;
      points.push(...boxEdges(pl.file.x + tx, pl.y, pl.file.z + tz, pl.file.depthR * s, 0.03, pl.file.width * s, pl.file.angle));
      const c = isLit(pl) ? tint(pl.color, 0.3) : tint(pl.color, dark ? -0.55 : 0.4);
      for (let i = 0; i < 12; i++) colors.push(c);
    }
    return { points, colors };
  }, [plates, lit, dark]); // eslint-disable-line react-hooks/exhaustive-deps
  if (plates.length === 0) return null;
  return (
    <>
      <instancedMesh
        key={plates.length}
        ref={ref}
        args={[undefined, undefined, plates.length]}
        onClick={(e) => {
          e.stopPropagation();
          const pl = plates[e.instanceId ?? -1];
          if (pl) onSelect(pl.commit ? pl.commit.id : `merge:${pl.branch.merge?.id}`);
        }}
        onPointerMove={(e) => {
          e.stopPropagation();
          const pl = plates[e.instanceId ?? -1];
          onHover(pl ? (pl.commit ? pl.commit.id : `merge:${pl.branch.merge?.id}`) : null);
        }}
        onPointerOut={() => onHover(null)}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshPhongMaterial transparent opacity={0.62} shininess={90} specular="#ffffff" depthWrite={false} />
      </instancedMesh>
      <Segments points={edges.points} colors={edges.colors} opacity={0.9} />
    </>
  );
}

// ---------------------------------------------------------------- threads and links

function Threads({ city, lit, p, dark }: { city: CityModel; lit: Lit; p: Palette; dark: boolean }) {
  const { points, colors, dashed } = useMemo(() => {
    const points: Vec3[] = [];
    const colors: string[] = [];
    const dashed: { key: string; from: Vec3; to: Vec3; color: string }[] = [];
    for (const b of city.branches) {
      if (b.yEnd <= 0.001 && b.yStart <= 0.001) continue;
      const on = lit.tasks.has(b.id);
      const base = on ? b.color : tint(b.color, dark ? -0.68 : 0.55);
      for (const path of b.files) {
        const f = city.byPath.get(path);
        if (!f) continue;
        // a faint stem from the block to the first commit, then the branch itself
        points.push([f.x, f.height, f.z], [f.x, b.yStart, f.z]);
        colors.push(tint(base, dark ? -0.5 : 0.3));
        if (b.state === "held") {
          dashed.push({ key: `${b.id}|${path}`, from: [f.x, b.yStart, f.z], to: [f.x, b.yEnd, f.z], color: on ? AMBER : tint(AMBER, dark ? -0.6 : 0.5) });
          continue;
        }
        points.push([f.x, b.yStart, f.z], [f.x, b.yEnd, f.z]);
        colors.push(b.state === "blocked" || b.state === "failed" ? (on ? RED : tint(RED, dark ? -0.6 : 0.5)) : b.state === "abandoned" ? tint(base, dark ? -0.4 : 0.3) : base);
      }
    }
    return { points, colors, dashed };
  }, [city, lit, dark]);
  void p;
  return (
    <>
      <Segments points={points} colors={colors} opacity={0.75} />
      {dashed.map((d) => (
        <Line key={d.key} points={[d.from, d.to]} color={d.color} lineWidth={1} dashed dashSize={0.06} gapSize={0.05} transparent opacity={0.9} />
      ))}
    </>
  );
}

function Links({ city, lit, p, dark }: { city: CityModel; lit: Lit; p: Palette; dark: boolean }) {
  const { points, colors } = useMemo(() => {
    const points: Vec3[] = [];
    const colors: string[] = [];
    for (const b of city.branches) {
      const on = lit.tasks.has(b.id);
      for (const c of b.commits) {
        if (!c.inWindow || c.files.length < 2) continue;
        const fs = c.files.map((x) => city.byPath.get(x)).filter((f): f is CityFile => f !== undefined).sort((a, z) => a.angle - z.angle);
        const col = (on ? tint(b.color, -0.15) : tint(b.color, dark ? -0.72 : 0.6));
        for (let i = 0; i + 1 < fs.length; i++) {
          const seg = segmentsOf(polarRoute(fs[i], fs[i + 1], c.y));
          points.push(...seg);
          for (let k = 0; k < seg.length / 2; k++) colors.push(col);
        }
      }
      if (b.merge && b.merge.y > 0) {
        const col = on ? tint(p.settled, -0.1) : tint(p.settled, dark ? -0.7 : 0.55);
        for (const path of b.files) {
          const f = city.byPath.get(path);
          if (!f) continue;
          points.push([COLUMN_R * Math.cos(f.angle), b.merge.y, COLUMN_R * Math.sin(f.angle)], [f.x, b.merge.y, f.z]);
          colors.push(col);
        }
      }
    }
    return { points, colors };
  }, [city, lit, p, dark]);
  return <Segments points={points} colors={colors} opacity={0.55} />;
}

// ---------------------------------------------------------------- the column

/** Height on the vertical plane through the column that faces the camera. */
function columnHeight(e: ThreeEvent<PointerEvent>, camera: THREE.Camera): number | null {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  dir.normalize();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, new THREE.Vector3(0, 0, 0));
  const hit = new THREE.Vector3();
  return e.ray.intersectPlane(plane, hit) ? hit.y : null;
}

function Ring({ r, tube, y, color, emissive = 0.6, opacity = 1, onClick, onHover, children }: { r: number; tube: number; y: number; color: string; emissive?: number; opacity?: number; onClick?: () => void; onHover?: (on: boolean) => void; children?: React.ReactNode }) {
  return (
    <mesh
      rotation={[Math.PI / 2, 0, 0]}
      position={[0, y, 0]}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      onPointerOver={onHover ? (e) => { e.stopPropagation(); onHover(true); } : undefined}
      onPointerOut={onHover ? () => onHover(false) : undefined}
    >
      <torusGeometry args={[r, tube, 10, 96]} />
      <meshPhongMaterial color={color} emissive={color} emissiveIntensity={emissive} transparent={opacity < 1} opacity={opacity} />
      {children}
    </mesh>
  );
}

function Column({ city, lit, p, at, compact, merging, picked, project, onSelect, onHover, onScrub, onReorder, setDragging }: {
  city: CityModel;
  lit: Lit;
  p: Palette;
  at: number | null;
  compact: boolean;
  merging: boolean;
  picked: string | null;
  project: string;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onScrub?: (at: number | null) => void;
  onReorder?: (order: string[]) => void;
  setDragging: (on: boolean) => void;
}) {
  void project;
  const { camera } = useThree();
  const lockRef = useRef<THREE.Mesh>(null);
  const [drag, setDrag] = useState<null | { kind: "now" } | { kind: "chamber"; id: string; order: string[] }>(null);
  useFrame(({ clock }) => {
    if (lockRef.current) lockRef.current.rotation.z = clock.elapsedTime * (merging ? 1.2 : 0.08);
  });
  const capture = (e: ThreeEvent<PointerEvent>) => (e.target as unknown as { setPointerCapture(id: number): void }).setPointerCapture(e.pointerId);
  const release = (e: ThreeEvent<PointerEvent>) => (e.target as unknown as { releasePointerCapture(id: number): void }).releasePointerCapture(e.pointerId);
  const chamber = drag?.kind === "chamber" ? drag.order.map((id, i) => ({ ...city.lock.find((c) => c.task.id === id)!, index: i, y: city.top - CHAMBER_STEP * (i + 1) })) : city.lock;
  // Merge labels: at most three, the latest lit ones, never two within a hair of each other,
  // sides alternating; the picked one always. The panel carries the rest.
  const labelled = useMemo(() => {
    const out = new Map<number, "left" | "right">();
    const kept: number[] = [];
    const recent = [...city.merges].filter((m) => m.y > 0.001).sort((a, b) => b.at - a.at);
    for (const m of recent) {
      const id = `merge:${m.id}`;
      const on = lit.merges.has(m.id) || lit.rest;
      if (picked !== id) {
        if (!on || kept.length >= 3) continue;
        if (kept.some((y) => Math.abs(y - m.y) < 0.11)) continue;
      }
      kept.push(m.y);
      out.set(m.id, kept.length % 2 === 1 ? "left" : "right");
    }
    return out;
  }, [city.merges, lit, picked]);
  const topLabel = at === null ? "now" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <group>
      <mesh position={[0, H / 2, 0]}>
        <cylinderGeometry args={[0.012, 0.012, H, 12]} />
        <meshPhongMaterial color={p.column} emissive={p.column} emissiveIntensity={0.5} />
      </mesh>
      {/* the lock at the origin */}
      <mesh ref={lockRef} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.004, 0]}>
        <torusGeometry args={[LOCK_R, 0.014, 10, 128]} />
        <meshPhongMaterial color={CERULEAN} emissive={CERULEAN} emissiveIntensity={merging ? 1.6 : 1.1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.003, 0]}>
        <circleGeometry args={[LOCK_R, 64]} />
        <meshBasicMaterial color={CERULEAN} transparent opacity={0.1} side={THREE.DoubleSide} />
      </mesh>
      {!compact && (
        <Html position={[0, 0.02, LOCK_R + 0.2]} center distanceFactor={11} style={{ pointerEvents: "none" }}>
          <div className="scene-label gate" style={{ transform: "none" }}>
            lock{city.lock.length ? ` · next ${city.lock[0].task.id.slice(-4)}` : ""}
          </div>
        </Html>
      )}
      {/* ticks: clock times, none inside a fold */}
      {city.ticks.filter((t) => t.y < H - 0.01 && t.y > 0.01).map((t, i) => (
        <group key={i}>
          <Ring r={t.major ? 0.14 : 0.09} tube={0.004} y={t.y} color={p.ring} emissive={0.3} />
          {!compact && t.label && (
            <Html position={[0, t.y, 0]} distanceFactor={12} style={{ pointerEvents: "none" }}>
              <div className="scene-tick">{t.label}</div>
            </Html>
          )}
        </group>
      ))}
      {/* folds: a quiet stretch shown as a short break in the column */}
      {city.scale.folds.filter((f) => f.y1 - f.y0 > 0.005).map((f, i) => (
        <group key={`fold-${i}`}>
          <mesh position={[0, (f.y0 + f.y1) / 2, 0]}>
            <cylinderGeometry args={[0.03, 0.03, Math.max(0.01, f.y1 - f.y0), 10]} />
            <meshBasicMaterial color={p.bg} />
          </mesh>
          <Line points={[[0, f.y0, 0], [0, f.y1, 0]]} color={p.ring} lineWidth={1.2} dashed dashSize={0.02} gapSize={0.02} />
          <Ring r={0.07} tube={0.004} y={f.y0} color={p.ring} emissive={0.2} />
          <Ring r={0.07} tube={0.004} y={f.y1} color={p.ring} emissive={0.2} />
          {!compact && (
            <Html position={[-0.12, (f.y0 + f.y1) / 2, 0]} distanceFactor={12} style={{ pointerEvents: "none" }}>
              <div className="scene-tick fold">{durationLabel(f.to - f.from)} quiet</div>
            </Html>
          )}
        </group>
      ))}
      {/* merges: white landed unattended, blue a person approved, a double ring resolved a conflict first */}
      {city.merges.filter((m) => m.y > 0.001).map((m) => {
        const on = lit.merges.has(m.id) || lit.rest;
        const color = m.kind === "approved" ? CERULEAN : p.settled;
        const id = `merge:${m.id}`;
        return (
          <group key={m.id}>
            <Ring r={COLUMN_R} tube={picked === id ? 0.014 : 0.008} y={m.y} color={on ? color : tint(color, p.dimK)} emissive={on ? 0.8 : 0.2} onClick={() => onSelect(id)} onHover={(h) => onHover(h ? id : null)} />
            {m.kind === "resolved" && <Ring r={COLUMN_R + 0.055} tube={0.005} y={m.y} color={on ? color : tint(color, p.dimK)} emissive={on ? 0.6 : 0.15} opacity={0.9} />}
            {!compact && labelled.has(m.id) && (
              <Html position={[labelled.get(m.id) === "left" ? -0.3 : 0.3, m.y, 0]} distanceFactor={12} style={{ pointerEvents: "none" }}>
                <div className={`scene-label ${labelled.get(m.id) === "left" ? "right" : ""}`}>
                  <span className="mono">{m.task.slice(-4)}</span>
                  <span className="text-muted-foreground"> · {m.kind}{m.score !== null ? ` ${m.score.toFixed(2)}` : ""}</span>
                </div>
              </Html>
            )}
          </group>
        );
      })}
      {/* the chamber: what waits to enter main, in order */}
      {chamber.map((c) => {
        const on = lit.tasks.has(c.task.id) || lit.rest;
        const dragging = drag?.kind === "chamber" && drag.id === c.task.id;
        return (
          <group key={c.task.id} position={[0, c.y, 0]}>
            <mesh
              onClick={(e) => { e.stopPropagation(); onSelect(c.task.id); }}
              onPointerOver={(e) => { e.stopPropagation(); onHover(c.task.id); }}
              onPointerOut={() => onHover(null)}
              onPointerDown={(e) => {
                if (!onReorder || c.task.status === "merging") return;
                e.stopPropagation();
                capture(e);
                setDragging(true);
                setDrag({ kind: "chamber", id: c.task.id, order: city.lock.map((x) => x.task.id) });
              }}
              onPointerMove={(e) => {
                if (drag?.kind !== "chamber" || drag.id !== c.task.id) return;
                e.stopPropagation();
                const y = columnHeight(e, camera);
                if (y === null) return;
                const i = chamberIndex(y, drag.order.length, city.top);
                const cur = drag.order.indexOf(c.task.id);
                if (i === cur) return;
                const order = drag.order.filter((x) => x !== c.task.id);
                order.splice(i, 0, c.task.id);
                setDrag({ ...drag, order });
              }}
              onPointerUp={(e) => {
                if (drag?.kind !== "chamber") return;
                e.stopPropagation();
                release(e);
                setDragging(false);
                const before = city.lock.map((x) => x.task.id);
                if (before.join() !== drag.order.join()) onReorder?.(drag.order);
                setDrag(null);
              }}
            >
              <cylinderGeometry args={[0.2, 0.2, 0.028, 40]} />
              <meshPhongMaterial color={on ? c.color : tint(c.color, p.dimK)} emissive={c.color} emissiveIntensity={dragging ? 1 : on ? 0.55 : 0.1} transparent opacity={0.92} />
            </mesh>
            {!compact && (on || dragging) && (
              <Html position={[0.3, 0, 0]} distanceFactor={12} style={{ pointerEvents: "none" }}>
                <div className="scene-label">
                  <span className="dot" style={{ background: c.color }} />
                  <span className="mono">{c.task.id.slice(-4)}</span>
                  <span className="text-muted-foreground">· {c.reason}</span>
                </div>
              </Html>
            )}
          </group>
        );
      })}
      {/* the now ring: drag it down to replay */}
      <mesh
        rotation={[Math.PI / 2, 0, 0]}
        position={[0, city.top, 0]}
        onPointerDown={(e) => {
          if (!onScrub) return;
          e.stopPropagation();
          capture(e);
          setDragging(true);
          setDrag({ kind: "now" });
        }}
        onPointerMove={(e) => {
          if (drag?.kind !== "now") return;
          e.stopPropagation();
          const y = columnHeight(e, camera);
          if (y !== null) onScrub?.(timeAtHeight(city, y));
        }}
        onPointerUp={(e) => {
          if (drag?.kind !== "now") return;
          e.stopPropagation();
          release(e);
          setDragging(false);
          setDrag(null);
        }}
        onPointerOver={(e) => { e.stopPropagation(); onHover("now"); }}
        onPointerOut={() => onHover(null)}
      >
        <torusGeometry args={[0.3, picked === "now" || drag?.kind === "now" ? 0.012 : 0.007, 10, 96]} />
        <meshPhongMaterial color={CERULEAN} emissive={CERULEAN} emissiveIntensity={at === null ? 1.1 : 1.6} />
      </mesh>
      {!compact && (
        <Html position={[0.36, city.top, 0]} distanceFactor={12} style={{ pointerEvents: "none" }}>
          <div className={`scene-tick now ${at === null ? "" : "replay"}`}>{topLabel}</div>
        </Html>
      )}
      {/* the rim of the moment shown */}
      <Segments points={segmentsOf(circle(city.maxRadius + 0.8, city.top))} colors={Array.from({ length: 128 }, () => p.ring)} opacity={at === null ? 0.5 : 0.9} />
      {!compact && (
        <Html position={[0, H + 0.5, 0]} center distanceFactor={12} style={{ pointerEvents: "none" }}>
          <div className="scene-main">main</div>
        </Html>
      )}
    </group>
  );
}

// ---------------------------------------------------------------- agents and overlaps

function Beacon({ a, city, lit, picked, compact, onSelect, onHover }: { a: CityModel["agents"][number]; city: CityModel; lit: Lit; picked: string | null; compact: boolean; onSelect: (id: string) => void; onHover: (id: string | null) => void }) {
  const ref = useRef<THREE.Group>(null);
  const target = useRef(new THREE.Vector3(...a.pos));
  useEffect(() => {
    target.current.set(...a.pos);
  }, [a.pos]);
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g) return;
    g.position.lerp(target.current, 0.08);
    const pulse = a.state === "editing" ? 1 + Math.sin(clock.elapsedTime * 3) * 0.12 : 1;
    g.scale.setScalar(pulse * (picked === a.task.id ? 1.4 : 1));
  });
  const on = lit.tasks.has(a.task.id) || lit.rest;
  const reading = a.state === "reading" || a.state === "queued";
  const file = a.file ? city.byPath.get(a.file) : undefined;
  const color = a.state === "blocked" ? RED : a.state === "held" ? AMBER : a.color;
  const label = `${a.task.id.slice(-4)} · ${a.state}${file ? ` ${file.name}` : ""}`;
  return (
    <>
      {file && <Line points={[[file.x, file.height, file.z], [a.pos[0], a.pos[1] - 0.09, a.pos[2]]]} color={on ? color : tint(color, -0.6)} lineWidth={1} transparent opacity={reading ? 0.35 : 0.75} />}
      <group ref={ref} position={a.pos}>
        <mesh
          onClick={(e) => { e.stopPropagation(); onSelect(a.task.id); }}
          onPointerOver={(e) => { e.stopPropagation(); onHover(a.task.id); }}
          onPointerOut={() => onHover(null)}
        >
          <sphereGeometry args={[compact ? 0.07 : 0.085, 28, 18]} />
          <meshPhongMaterial color={color} emissive={color} emissiveIntensity={!on ? 0.15 : reading ? 0.5 : 1.1} shininess={100} specular="#ffffff" transparent={reading || !on} opacity={!on ? 0.45 : reading ? 0.75 : 1} />
        </mesh>
        {(on || picked === a.task.id) && (
          <Html position={[0.14, 0.1, 0]} distanceFactor={12} style={{ pointerEvents: "none" }}>
            <div className="scene-agent" style={{ color }}>{label}</div>
          </Html>
        )}
      </group>
    </>
  );
}

function Halos({ city, compact }: { city: CityModel; compact: boolean }) {
  return (
    <>
      {[...city.overlaps.entries()].map(([path, ids]) => {
        const f = city.byPath.get(path);
        if (!f) return null;
        const r = Math.max(f.width, f.depthR) * 0.8;
        return (
          <group key={path} position={[f.x, 0.006, f.z]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[r, r + 0.035, 64]} />
              <meshBasicMaterial color={RED} transparent opacity={0.95} side={THREE.DoubleSide} />
            </mesh>
            {!compact && (
              <Html position={[0, 0, r + 0.1]} center distanceFactor={12} style={{ pointerEvents: "none" }}>
                <div className="scene-halo">overlap · {ids.length} agents</div>
              </Html>
            )}
          </group>
        );
      })}
    </>
  );
}

function PickedLabel({ city, picked, project }: { city: CityModel; picked: string | null; project: string }) {
  if (!picked) return null;
  if (picked.startsWith(`file:${project}:`)) {
    const f = city.byPath.get(picked.slice(`file:${project}:`.length));
    if (!f) return null;
    return (
      <Html position={[f.x, f.height + 0.08, f.z]} distanceFactor={12} style={{ pointerEvents: "none" }}>
        <div className="scene-label">
          <span className="mono">{f.path}</span>
          {f.ghost && <span className="text-muted-foreground"> · not on main yet</span>}
          {f.deleted && <span className="text-muted-foreground"> · deleted</span>}
        </div>
      </Html>
    );
  }
  if (picked.startsWith("commit:")) {
    const c = city.commits.find((x) => x.id === picked);
    const f = c?.files.map((p) => city.byPath.get(p)).find((x) => x !== undefined);
    if (!c || !f) return null;
    return (
      <Html position={[f.x, c.y + 0.06, f.z]} distanceFactor={12} style={{ pointerEvents: "none" }}>
        <div className="scene-label">
          <span className="mono text-blue-400">{c.sha.slice(0, 7)}</span> {c.message.slice(0, 56)}
          <span className="text-muted-foreground"> · {c.files.length} file{c.files.length === 1 ? "" : "s"}</span>
        </div>
      </Html>
    );
  }
  return null;
}

// ---------------------------------------------------------------- scene

function Content(props: CityProps) {
  const { state, activity, now, at, windowMs, selected, hovered, onSelect, onHover, onScrub, onReorder, dark, focus, compact } = props;
  const p = palette(dark);
  const built = useMemo(() => (props.city ? null : buildCity(state, { now, windowMs, activity, at })), [props.city, state, now, windowMs, activity, at]);
  const city = props.city ?? built!;
  const picked = selected ?? focus ?? hovered ?? null;
  const lit = useMemo(() => litFor(city, picked === "now" ? null : picked), [city, picked]);
  const merging = state.tasks.some((t) => t.status === "merging");
  const project = state.project?.id ?? "sample-api";
  const [dragging, setDragging] = useState(false);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  useEffect(() => {
    if (controls.current) controls.current.enabled = !dragging;
  }, [dragging]);
  return (
    <>
      <hemisphereLight args={["#8fb6ff", dark ? "#0a0f1e" : "#dfe6f5", 0.9]} />
      <directionalLight position={[6, 10, 4]} intensity={1.3} />
      <pointLight position={[0, 0.6, 0]} color={CERULEAN} intensity={6} distance={7} decay={2} />
      <Floor city={city} p={p} compact={!!compact} />
      <Blocks city={city} lit={lit} dark={dark} project={project} onSelect={onSelect} onHover={onHover} />
      <Threads city={city} lit={lit} p={p} dark={dark} />
      <Links city={city} lit={lit} p={p} dark={dark} />
      <Plates city={city} lit={lit} p={p} dark={dark} onSelect={onSelect} onHover={onHover} />
      <Column city={city} lit={lit} p={p} at={at} compact={!!compact} merging={merging} picked={picked} project={project} onSelect={onSelect} onHover={onHover} onScrub={onScrub} onReorder={onReorder} setDragging={setDragging} />
      {city.agents.map((a) => (
        <Beacon key={a.task.id} a={a} city={city} lit={lit} picked={picked} compact={!!compact} onSelect={onSelect} onHover={onHover} />
      ))}
      <Halos city={city} compact={!!compact} />
      {!compact && <PickedLabel city={city} picked={picked} project={project} />}
      <OrbitControls ref={controls} target={[0, 0.9, 0]} rotateSpeed={0.35} enablePan={false} minDistance={3} maxDistance={60} autoRotate={!selected && !hovered && !dragging && !focus} autoRotateSpeed={0.35} enableDamping dampingFactor={0.08} makeDefault />
    </>
  );
}

export default function City(props: CityProps) {
  const maxR = useMemo(() => {
    const depths = new Set(props.state.positions.filter((p) => p.kind === "file").map((p) => p.label.split("/").length));
    return ringRadius(Math.max(2, ...depths));
  }, [props.state.positions]);
  const dist = (props.compact ? 2 : 2.15) * maxR + 2;
  const elev = (27 * Math.PI) / 180;
  const az = 0.9;
  return (
    <Canvas
      camera={{ position: [Math.cos(az) * Math.cos(elev) * dist, Math.sin(elev) * dist + 1, Math.sin(az) * Math.cos(elev) * dist], fov: 34 }}
      dpr={[1, 2]}
      onPointerMissed={() => props.onSelect(null)}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={[palette(props.dark).bg]} />
      <fogExp2 attach="fog" args={[palette(props.dark).bg, 0.018]} />
      <Content {...props} />
    </Canvas>
  );
}
