"use client";

import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { Color, type Group, type Mesh, Quaternion, Vector3 } from "three";

import { type ActivityEvent, isLive, type StateView, type TaskView } from "@/lib/api";
import { computeLayout, type Layout, RING_RADIUS, type Vec3 } from "@/lib/layout";

export interface SceneProps {
  state: StateView;
  selected: string | null;
  hovered: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  activity: Record<string, ActivityEvent[]>;
  dark: boolean;
  focus?: string | null;
  compact?: boolean;
}

const PLANE_W = 12;
const GRID = 14;
const BLUE = "#1370f2";
const STATUS: Record<string, string> = {
  queued: "#9aa3b2",
  running: "#1370f2",
  ready: "#ffffff",
  merging: "#1370f2",
  approved: "#1370f2",
  needs_review: "#f5b94a",
  blocked: "#c20808",
  failed: "#ff1919",
  abandoned: "#4b5366",
};

const v3 = (a: Vec3) => new Vector3(a[0], a[1], a[2]);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The ground grid from the reference: thin lines that fade toward the edge, tinted blue in the dark. */
function Grid({ size, dark }: { size: number; dark: boolean }) {
  const half = size / 2;
  const color = (i: number) => {
    const t = Math.abs(i) / half;
    if (dark) {
      const l = lerp(0.1, 0.065, t);
      return new Color(l, l * 1.15, l * 1.5);
    }
    const l = lerp(0.82, 0.9, t);
    return new Color(l, l * 1.005, l * 1.02);
  };
  const lines = useMemo(() => {
    const out: { key: string; points: [Vec3, Vec3]; i: number }[] = [];
    for (let k = 0; k <= size; k++) {
      const i = -half + k;
      out.push({ key: `x${k}`, points: [[i, 0, half], [i, 0, -half]], i });
      out.push({ key: `z${k}`, points: [[half, 0, i], [-half, 0, i]], i });
    }
    return out;
  }, [size, half]);
  return (
    <>
      {lines.map((l) => (
        <Line key={l.key} points={l.points} color={color(l.i)} lineWidth={1} />
      ))}
    </>
  );
}

/** A glassy square through the origin with outlined edges, oriented by its normal. */
function DirPlane({ normal, u, v, color, dir, dark, compact }: { normal: Vec3; u: Vec3; v: Vec3; color: string; dir: string; dark: boolean; compact: boolean }) {
  const q = useMemo(() => new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), v3(normal)), [normal]);
  const half = PLANE_W / 2;
  const corner = v3(u).multiplyScalar(half - 0.5).add(v3(v).multiplyScalar(half - 0.5));
  return (
    <group quaternion={q}>
      <mesh>
        <boxGeometry args={[PLANE_W, PLANE_W, 0.01]} />
        <meshPhysicalMaterial color={color} transparent opacity={dark ? 0.16 : 0.12} roughness={0} transmission={0.9} depthWrite={false} />
      </mesh>
      {([
        [half, 0, 0, 0],
        [-half, 0, 0, 0],
        [0, half, 0, Math.PI / 2],
        [0, -half, 0, Math.PI / 2],
      ] as [number, number, number, number][]).map(([x, y, z, rz], i) => (
        <mesh key={i} position={[x, y, z]} rotation={[0, 0, rz]} scale={[1, PLANE_W, 1]}>
          <cylinderGeometry args={[0.014, 0.014, 1, 12]} />
          <meshPhongMaterial color={color} />
        </mesh>
      ))}
      {!compact && (
        <Html position={[0, 0, 0]} distanceFactor={14} style={{ pointerEvents: "none", transform: `translate(${corner.x * 0}px, 0)` }}>
          <span />
        </Html>
      )}
      {!compact && (
        <group position={[half - 0.6, half - 0.6, 0.02]}>
          <Html distanceFactor={16} center style={{ pointerEvents: "none" }}>
            <div className="scene-dir" style={{ color }}>{dir === "." ? "ROOT" : dir.toUpperCase()}</div>
          </Html>
        </group>
      )}
    </group>
  );
}

function Point({ position, radius, color, emissive = 0.2, onSelect, onHover, id, label, lit }: { position: Vec3; radius: number; color: string; emissive?: number; onSelect: (id: string) => void; onHover: (id: string | null) => void; id: string; label?: string; lit: boolean }) {
  return (
    <mesh
      position={position}
      scale={lit ? 1.6 : 1}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(id);
      }}
      onPointerOut={() => onHover(null)}
    >
      <sphereGeometry args={[radius, 14, 14]} />
      <meshPhongMaterial color={color} emissive={color} emissiveIntensity={lit ? 0.9 : emissive} />
      {lit && label && (
        <Html distanceFactor={12} style={{ pointerEvents: "none" }}>
          <div className="scene-label">{label}</div>
        </Html>
      )}
    </mesh>
  );
}

/** A commit drifts slowly around its plane's normal; the ring is the origin it orbits. */
function CommitPoint({ id, base, normal, orbit, radius, color, lit, label, born, onSelect, onHover }: { id: string; base: Vec3; normal: Vec3; orbit: boolean; radius: number; color: string; lit: boolean; label: string; born: number; onSelect: (id: string) => void; onHover: (id: string | null) => void }) {
  const ref = useRef<Mesh>(null);
  const axis = useMemo(() => v3(normal), [normal]);
  const start = useMemo(() => v3(base), [base]);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const r = start.length();
    const angle = orbit ? (clock.elapsedTime * 0.035) / Math.max(1, r * 0.6) : 0;
    const p = start.clone().applyAxisAngle(axis, angle);
    m.position.copy(p);
    const age = clock.elapsedTime - born;
    const grow = born < 0 ? 1 : Math.min(1, age / 0.8);
    m.scale.setScalar((1 - Math.pow(1 - grow, 3)) * (lit ? 1.7 : 1));
  });
  return (
    <mesh
      ref={ref}
      position={base}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(id);
      }}
      onPointerOut={() => onHover(null)}
    >
      <sphereGeometry args={[radius, 14, 14]} />
      <meshPhongMaterial color={color} emissive={color} emissiveIntensity={lit ? 0.9 : 0.3} />
      {lit && (
        <Html distanceFactor={12} style={{ pointerEvents: "none" }}>
          <div className="scene-label">{label}</div>
        </Html>
      )}
    </mesh>
  );
}

function DropLine({ from, to, color }: { from: Vec3; to: Vec3; color: string }) {
  const { mid, q, length } = useMemo(() => {
    const a = v3(from);
    const b = v3(to);
    const d = b.clone().sub(a);
    const length = d.length();
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize());
    return { mid: a.clone().add(b).multiplyScalar(0.5), q, length };
  }, [from, to]);
  if (length < 0.01) return null;
  return (
    <mesh position={mid} quaternion={q} scale={[1, length, 1]}>
      <cylinderGeometry args={[0.012, 0.012, 1, 10]} />
      <meshBasicMaterial color={color} transparent opacity={0.55} />
    </mesh>
  );
}

function Agent({ task, base, normal, height, selected, hovered, focus, acts, onSelect, onHover }: { task: TaskView; base: Vec3; normal: Vec3; height: number; selected: boolean; hovered: boolean; focus: boolean; acts: ActivityEvent[]; onSelect: (id: string) => void; onHover: (id: string | null) => void }) {
  const ref = useRef<Group>(null);
  const color = STATUS[task.status] ?? "#9ca3af";
  const merging = task.status === "merging" || task.status === "approved";
  const target = useMemo<Vec3>(() => {
    if (merging) return [0, 0.22, 0];
    const b = v3(base);
    const n = v3(normal).multiplyScalar(height);
    return [b.x + n.x, b.y + n.y, b.z + n.z];
  }, [base, normal, height, merging]);
  const [pos, setPos] = useState<Vec3>(target);
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g) return;
    g.position.x += (target[0] - g.position.x) * 0.05;
    g.position.y += (target[1] - g.position.y) * 0.05;
    g.position.z += (target[2] - g.position.z) * 0.05;
    const pulse = task.status === "running" ? 1 + Math.sin(clock.elapsedTime * 3) * 0.14 : 1;
    g.scale.setScalar(pulse * (selected || hovered || focus ? 1.35 : 1));
    if (Math.abs(g.position.x - pos[0]) + Math.abs(g.position.y - pos[1]) + Math.abs(g.position.z - pos[2]) > 0.02) setPos([g.position.x, g.position.y, g.position.z]);
  });
  const lit = selected || hovered || focus;
  const ticks = acts.filter((a) => a.kind === "tool").slice(-8);
  return (
    <>
      {!merging && <DropLine from={pos} to={base} color={color} />}
      <group ref={ref} position={target}>
        <mesh
          onClick={(e) => {
            e.stopPropagation();
            onSelect(task.id);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            onHover(task.id);
          }}
          onPointerOut={() => onHover(null)}
        >
          <sphereGeometry args={[0.15, 20, 20]} />
          <meshPhongMaterial color={color} emissive={color} emissiveIntensity={0.7} />
        </mesh>
        {task.status === "running" && (
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.27, 0.012, 8, 48]} />
            <meshBasicMaterial color={BLUE} />
          </mesh>
        )}
        {task.status === "needs_review" && (
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.27, 0.01, 8, 48]} />
            <meshBasicMaterial color="#f5b94a" transparent opacity={0.8} />
          </mesh>
        )}
        {ticks.map((a, i) => {
          const ang = (i / 8) * Math.PI * 2;
          const c = a.kind === "tool" && a.name === "Bash" ? BLUE : a.kind === "tool" && (a.name === "Edit" || a.name === "Write") ? "#ffffff" : "#8a97b3";
          return (
            <mesh key={i} position={[Math.cos(ang) * 0.38, 0, Math.sin(ang) * 0.38]}>
              <sphereGeometry args={[0.024, 8, 8]} />
              <meshBasicMaterial color={c} />
            </mesh>
          );
        })}
        {(lit || (isLive(task.status) && task.status !== "queued")) && (
          <Html distanceFactor={12} position={[0.24, 0, 0]} style={{ pointerEvents: "none" }}>
            <div className="scene-label">
              <span className="dot" style={{ background: color }} /> {task.id.slice(-4)} · {task.goal.slice(0, 48)}
              {task.goal.length > 48 ? "…" : ""}
            </div>
          </Html>
        )}
      </group>
    </>
  );
}

function Ring({ busy, head }: { busy: boolean; head: string | null }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.rotation.z = clock.elapsedTime * (busy ? 1.2 : 0.15);
  });
  return (
    <group>
      <mesh ref={ref} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[RING_RADIUS, 0.04, 16, 96]} />
        <meshPhongMaterial color={BLUE} emissive={BLUE} emissiveIntensity={busy ? 1.2 : 0.5} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[RING_RADIUS * 0.72, 0.012, 8, 64]} />
        <meshBasicMaterial color={BLUE} transparent opacity={0.35} />
      </mesh>
      <Html distanceFactor={14} position={[0, -0.55, 0]} center style={{ pointerEvents: "none" }}>
        <div className="scene-label gate">main <span className="mono">{head ? head.slice(0, 7) : "—"}</span></div>
      </Html>
    </group>
  );
}

function Ripple({ t0, onDone }: { t0: number; onDone: () => void }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const k = (clock.elapsedTime - t0) / 1.8;
    if (k >= 1) {
      onDone();
      return;
    }
    m.scale.setScalar(1 + k * 9);
    (m.material as { opacity: number }).opacity = (1 - k) * 0.5;
  });
  return (
    <mesh ref={ref} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
      <torusGeometry args={[RING_RADIUS, 0.012, 8, 96]} />
      <meshBasicMaterial color={BLUE} transparent opacity={0.5} />
    </mesh>
  );
}

function Content({ state, selected, hovered, onSelect, onHover, activity, dark, focus, compact }: SceneProps) {
  const now = useRef(Date.now());
  const layout: Layout = useMemo(() => computeLayout(state, now.current), [state]);
  const merging = state.tasks.some((t) => t.status === "merging" || t.status === "approved");
  const born = useRef(new Map<string, number>());
  const mountedAt = useRef<number | null>(null);
  const clockRef = useRef(0);
  const [ripples, setRipples] = useState<number[]>([]);
  const prevMerged = useRef<Set<string> | null>(null);
  useFrame(({ clock }) => {
    clockRef.current = clock.elapsedTime;
    if (mountedAt.current === null) mountedAt.current = clock.elapsedTime;
  });
  useEffect(() => {
    const merged = new Set(state.tasks.filter((t) => t.status === "merged").map((t) => t.id));
    if (prevMerged.current) for (const id of merged) if (!prevMerged.current.has(id)) setRipples((r) => [...r, clockRef.current]);
    prevMerged.current = merged;
  }, [state.tasks]);
  for (const id of layout.commits.keys()) {
    if (!born.current.has(id)) born.current.set(id, mountedAt.current !== null && clockRef.current - mountedAt.current > 2 ? clockRef.current : -1);
  }
  const fileColor = dark ? "#cfd6e4" : "#4b5563";
  const edges = state.edges
    .map((e) => ({ ...e, a: layout.tasks.get(e.a), b: layout.tasks.get(e.b) }))
    .filter((e) => e.a && e.b)
    .map((e) => {
      const pa = e.a!;
      const pb = e.b!;
      const na = layout.planes[pa.plane]?.normal ?? [0, 1, 0];
      const nb = layout.planes[pb.plane]?.normal ?? [0, 1, 0];
      const A: Vec3 = [pa.base[0] + na[0] * pa.height, pa.base[1] + na[1] * pa.height, pa.base[2] + na[2] * pa.height];
      const B: Vec3 = [pb.base[0] + nb[0] * pb.height, pb.base[1] + nb[1] * pb.height, pb.base[2] + nb[2] * pb.height];
      return { A, B, strength: Math.max(e.cosine, e.paths) };
    });
  return (
    <>
      <ambientLight intensity={Math.PI / 2} />
      <spotLight position={[10, 10, 10]} angle={0.15} penumbra={1} decay={0} intensity={Math.PI} />
      <pointLight position={[-10, -10, -10]} decay={0} intensity={Math.PI} />
      <Grid size={GRID} dark={dark} />
      {layout.planes.map((p) => (
        <DirPlane key={p.dir} normal={p.normal} u={p.u} v={p.v} color={p.color} dir={p.dir} dark={dark} compact={!!compact} />
      ))}
      {state.positions
        .filter((p) => p.kind === "file")
        .map((p) => {
          const f = layout.files.get(p.id);
          if (!f) return null;
          return <Point key={p.id} id={p.id} position={f.pos} radius={0.085} color={fileColor} onSelect={onSelect} onHover={onHover} label={p.label} lit={hovered === p.id || selected === p.id} />;
        })}
      {state.positions
        .filter((p) => p.kind === "commit")
        .map((p) => {
          const c = layout.commits.get(p.id);
          if (!c) return null;
          const n = layout.planes[c.planes[0]]?.normal ?? [0, 1, 0];
          const lit = hovered === p.id || selected === p.id || (!!focus && p.meta?.task === focus);
          return (
            <CommitPoint
              key={p.id}
              id={p.id}
              base={c.pos}
              normal={n}
              orbit={c.planes.length === 1}
              radius={p.meta?.merge ? 0.1 : 0.08}
              color={BLUE}
              lit={lit}
              label={`${p.meta?.sha?.slice(0, 7) ?? ""} ${p.label}`}
              born={born.current.get(p.id) ?? -1}
              onSelect={onSelect}
              onHover={onHover}
            />
          );
        })}
      {edges.map((e, i) => (
        <Line key={i} points={[e.A, e.B]} color={e.strength > 0.7 ? "#ff1919" : e.strength > 0.45 ? "#f5b94a" : "#8a97b3"} lineWidth={1 + e.strength * 2} transparent opacity={0.8} />
      ))}
      {state.tasks.map((t) => {
        const a = layout.tasks.get(t.id);
        if (!a || t.status === "merged" || t.status === "abandoned") return null;
        return (
          <Agent key={t.id} task={t} base={a.base} normal={layout.planes[a.plane]?.normal ?? [0, 1, 0]} height={a.height} selected={selected === t.id} hovered={hovered === t.id} focus={focus === t.id} acts={activity[t.id] ?? []} onSelect={onSelect} onHover={onHover} />
        );
      })}
      <Ring busy={merging} head={state.project?.head ?? null} />
      {ripples.map((t0, i) => (
        <Ripple key={`${t0}-${i}`} t0={t0} onDone={() => setRipples((r) => r.filter((x) => x !== t0))} />
      ))}
      <OrbitControls rotateSpeed={0.3} enablePan={false} enableZoom minDistance={6} maxDistance={34} autoRotate={!selected && !hovered} autoRotateSpeed={0.7} enableDamping dampingFactor={0.08} makeDefault />
    </>
  );
}

export default function Scene(props: SceneProps) {
  const dist = props.compact ? 13 : 16.8;
  const angle = (20 * Math.PI) / 180;
  return (
    <Canvas camera={{ position: [0, Math.sin(angle) * dist, Math.cos(angle) * dist], fov: 45 }} dpr={[1, 2]} onPointerMissed={() => props.onSelect(null)} style={{ position: "absolute", inset: 0 }}>
      <color attach="background" args={[props.dark ? "#090d13" : "#f7f8fb"]} />
      <Content {...props} />
    </Canvas>
  );
}
