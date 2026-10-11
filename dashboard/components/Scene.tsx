"use client";

import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Group, Mesh } from "three";

import { type ActivityEvent, isLive, type PositionView, type StateView, type TaskView } from "@/lib/api";

const S = 3.2;
const GATE: [number, number, number] = [6.2, 0.3, 0];

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

const pos = (p: PositionView): [number, number, number] => [p.x * S, p.y * S, p.z * S];

function dirColor(dir: string | undefined, dark: boolean): string {
  let h = 0;
  for (const ch of dir ?? ".") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} ${dark ? 55 : 60}% ${dark ? 68 : 42}%)`;
}

const STATUS: Record<string, string> = {
  queued: "#7f8aa3",
  running: "#3b82f6",
  ready: "#e5e7eb",
  merging: "#3b82f6",
  approved: "#3b82f6",
  needs_review: "#f5b94a",
  merged: "#9ca3af",
  blocked: "#d64fcf",
  failed: "#f87171",
  abandoned: "#4b5366",
};

function FilePoint({ p, dark, hovered, selected, onSelect, onHover }: { p: PositionView; dark: boolean; hovered: boolean; selected: boolean; onSelect: (id: string) => void; onHover: (id: string | null) => void }) {
  const color = dirColor(p.meta?.dir, dark);
  const lit = hovered || selected;
  return (
    <mesh
      position={pos(p)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(p.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(p.id);
      }}
      onPointerOut={() => onHover(null)}
    >
      <sphereGeometry args={[lit ? 0.085 : 0.055, 18, 18]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={lit ? 1 : 0.35} />
      {lit && (
        <Html distanceFactor={12} style={{ pointerEvents: "none" }}>
          <div className="scene-label">{p.label}</div>
        </Html>
      )}
    </mesh>
  );
}

function CommitPoint({ p, hovered, selected, focus, onSelect, onHover, born }: { p: PositionView; hovered: boolean; selected: boolean; focus: boolean; onSelect: (id: string) => void; onHover: (id: string | null) => void; born: number }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const age = clock.elapsedTime - born;
    const grow = born < 0 ? 1 : Math.min(1, age / 0.7);
    const eased = 1 - Math.pow(1 - grow, 3);
    const base = (p.meta?.merge ? 1.25 : 1) * (hovered || selected || focus ? 1.6 : 1);
    m.scale.setScalar(eased * base);
    m.rotation.y = clock.elapsedTime * 0.6;
  });
  return (
    <mesh
      ref={ref}
      position={pos(p)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(p.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(p.id);
      }}
      onPointerOut={() => onHover(null)}
    >
      <octahedronGeometry args={[0.075, 0]} />
      <meshStandardMaterial color="#3b82f6" emissive="#3b82f6" emissiveIntensity={hovered || selected || focus ? 1.2 : 0.55} transparent opacity={0.95} />
      {(hovered || selected) && (
        <Html distanceFactor={12} style={{ pointerEvents: "none" }}>
          <div className="scene-label">
            <span className="mono text-blue-400">{p.meta?.sha?.slice(0, 7)}</span> {p.label}
          </div>
        </Html>
      )}
    </mesh>
  );
}

function TaskNode({ task, position, selected, hovered, focus, acts, onSelect, onHover }: { task: TaskView; position: [number, number, number]; selected: boolean; hovered: boolean; focus: boolean; acts: ActivityEvent[]; onSelect: (id: string) => void; onHover: (id: string | null) => void }) {
  const ref = useRef<Group>(null);
  const color = STATUS[task.status] ?? "#9ca3af";
  const target = task.status === "merging" || task.status === "approved" ? GATE : task.status === "needs_review" ? [GATE[0] - 1.1, GATE[1], GATE[2]] : position;
  const faded = task.status === "merged" || task.status === "abandoned";
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g) return;
    g.position.x += (target[0] - g.position.x) * 0.05;
    g.position.y += (target[1] - g.position.y) * 0.05;
    g.position.z += (target[2] - g.position.z) * 0.05;
    const pulse = task.status === "running" ? 1 + Math.sin(clock.elapsedTime * 3) * 0.16 : 1;
    g.scale.setScalar(pulse * (selected || hovered || focus ? 1.35 : 1));
  });
  const ticks = acts.filter((a) => a.kind === "tool").slice(-8);
  return (
    <group ref={ref} position={position}>
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
        <sphereGeometry args={[faded ? 0.08 : 0.14, 24, 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={faded ? 0.15 : 0.9} transparent opacity={faded ? 0.5 : 1} />
      </mesh>
      {task.status === "running" && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.24, 0.012, 8, 48]} />
          <meshStandardMaterial color="#3b82f6" emissive="#3b82f6" emissiveIntensity={1} />
        </mesh>
      )}
      {task.status === "needs_review" && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.24, 0.01, 8, 48]} />
          <meshStandardMaterial color="#f5b94a" emissive="#f5b94a" emissiveIntensity={0.8} transparent opacity={0.8} />
        </mesh>
      )}
      {ticks.map((a, i) => {
        const ang = (i / 8) * Math.PI * 2;
        const c = a.kind === "tool" && a.name === "Bash" ? "#3b82f6" : a.kind === "tool" && (a.name === "Edit" || a.name === "Write") ? "#ffffff" : "#8a97b3";
        return (
          <mesh key={i} position={[Math.cos(ang) * 0.34, Math.sin(ang) * 0.34, 0]}>
            <sphereGeometry args={[0.022, 8, 8]} />
            <meshBasicMaterial color={c} />
          </mesh>
        );
      })}
      {(selected || hovered || focus || (isLive(task.status) && task.status !== "queued")) && (
        <Html distanceFactor={12} position={[0.22, 0, 0]} style={{ pointerEvents: "none" }}>
          <div className={`scene-label ${task.status}`}>
            <span className="dot" style={{ background: color }} /> {task.id.slice(-4)} · {task.goal.slice(0, 48)}
            {task.goal.length > 48 ? "…" : ""}
          </div>
        </Html>
      )}
    </group>
  );
}

function Gate({ busy, head }: { busy: boolean; head: string | null }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.rotation.y = clock.elapsedTime * (busy ? 0.9 : 0.25);
  });
  return (
    <group position={GATE}>
      <mesh ref={ref}>
        <torusGeometry args={[0.5, 0.025, 16, 96]} />
        <meshStandardMaterial color="#3b82f6" emissive="#3b82f6" emissiveIntensity={busy ? 1.4 : 0.6} />
      </mesh>
      <Html distanceFactor={14} position={[0, -0.8, 0]} style={{ pointerEvents: "none" }}>
        <div className="scene-label gate">
          merge gate · main <span className="mono">{head ? head.slice(0, 7) : "—"}</span>
        </div>
      </Html>
    </group>
  );
}

function Ripple({ t0, onDone }: { t0: number; onDone: () => void }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const k = (clock.elapsedTime - t0) / 1.6;
    if (k >= 1) {
      onDone();
      return;
    }
    const r = 0.7 + k * 7;
    m.scale.setScalar(r);
    (m.material as { opacity: number }).opacity = (1 - k) * 0.6;
  });
  return (
    <mesh ref={ref} position={GATE}>
      <torusGeometry args={[1, 0.015, 8, 96]} />
      <meshBasicMaterial color="#3b82f6" transparent opacity={0.6} />
    </mesh>
  );
}

function DirLabels({ files, dark }: { files: PositionView[]; dark: boolean }) {
  const dirs = useMemo(() => {
    const m = new Map<string, { x: number; y: number; z: number; n: number }>();
    for (const f of files) {
      const d = f.meta?.dir ?? ".";
      const a = m.get(d) ?? { x: 0, y: 0, z: 0, n: 0 };
      a.x += f.x;
      a.y += f.y;
      a.z += f.z;
      a.n += 1;
      m.set(d, a);
    }
    return [...m.entries()].map(([dir, a]) => ({ dir, p: [(a.x / a.n) * S, (a.y / a.n) * S + 0.35, (a.z / a.n) * S] as [number, number, number] }));
  }, [files]);
  return (
    <>
      {dirs.map((d) => (
        <Html key={d.dir} position={d.p} distanceFactor={12} center style={{ pointerEvents: "none" }}>
          <div className="scene-dir" style={{ color: dirColor(d.dir, dark) }}>{d.dir.toUpperCase()}</div>
        </Html>
      ))}
    </>
  );
}

function Content({ state, selected, hovered, onSelect, onHover, activity, dark, focus, compact }: SceneProps) {
  const files = state.positions.filter((p) => p.kind === "file");
  const commits = state.positions.filter((p) => p.kind === "commit");
  const taskPos = useMemo(() => {
    const m = new Map<string, [number, number, number]>();
    for (const p of state.positions) if (p.kind === "task" && p.meta?.task) m.set(p.meta.task, pos(p));
    return m;
  }, [state.positions]);
  const tasks = state.tasks.filter((t) => taskPos.has(t.id));
  const edges = state.edges
    .map((e) => ({ ...e, a: taskPos.get(e.a), b: taskPos.get(e.b) }))
    .filter((e) => e.a && e.b) as { a: [number, number, number]; b: [number, number, number]; cosine: number; paths: number }[];
  const merging = state.tasks.some((t) => t.status === "merging" || t.status === "approved");
  // commits born after mount get a landing animation; ripples mark merges
  const born = useRef(new Map<string, number>());
  const mountedAt = useRef<number | null>(null);
  const [ripples, setRipples] = useState<number[]>([]);
  const prevMerged = useRef<Set<string> | null>(null);
  const clockRef = useRef(0);
  useFrame(({ clock }) => {
    clockRef.current = clock.elapsedTime;
    if (mountedAt.current === null) mountedAt.current = clock.elapsedTime;
  });
  useEffect(() => {
    const merged = new Set(state.tasks.filter((t) => t.status === "merged").map((t) => t.id));
    if (prevMerged.current) {
      for (const id of merged) if (!prevMerged.current.has(id)) setRipples((r) => [...r, clockRef.current]);
    }
    prevMerged.current = merged;
  }, [state.tasks]);
  for (const c of commits) {
    if (!born.current.has(c.id)) born.current.set(c.id, mountedAt.current !== null && clockRef.current - mountedAt.current > 2 ? clockRef.current : -1);
  }
  return (
    <>
      <ambientLight intensity={0.75} />
      <pointLight position={[8, 8, 8]} intensity={1.2} />
      <pointLight position={[-8, -3, -6]} intensity={0.5} color="#3b82f6" />
      {!compact && <DirLabels files={files} dark={dark} />}
      {files.map((p) => (
        <FilePoint key={p.id} p={p} dark={dark} hovered={hovered === p.id} selected={selected === p.id} onSelect={onSelect} onHover={onHover} />
      ))}
      {commits.map((p) => (
        <CommitPoint key={p.id} p={p} hovered={hovered === p.id} selected={selected === p.id} focus={!!focus && p.meta?.task === focus} onSelect={onSelect} onHover={onHover} born={born.current.get(p.id) ?? -1} />
      ))}
      {edges.map((e, i) => {
        const strength = Math.max(e.cosine, e.paths);
        return <Line key={i} points={[e.a, e.b]} color={strength > 0.7 ? "#f87171" : strength > 0.45 ? "#f5b94a" : "#8a97b3"} lineWidth={1 + strength * 3} transparent opacity={0.8} />;
      })}
      {tasks.map((t) => (
        <TaskNode key={t.id} task={t} position={taskPos.get(t.id)!} selected={selected === t.id} hovered={hovered === t.id} focus={focus === t.id} acts={activity[t.id] ?? []} onSelect={onSelect} onHover={onHover} />
      ))}
      <Gate busy={merging} head={state.project?.head ?? null} />
      {ripples.map((t0, i) => (
        <Ripple key={`${t0}-${i}`} t0={t0} onDone={() => setRipples((r) => r.filter((x) => x !== t0))} />
      ))}
      <OrbitControls enableDamping dampingFactor={0.08} minDistance={1.5} maxDistance={30} autoRotate={!selected && !hovered} autoRotateSpeed={0.12} target={[0.6, 0, 0]} makeDefault />
    </>
  );
}

export default function Scene(props: SceneProps) {
  return (
    <Canvas camera={{ position: [1.2, 2.2, 8.5], fov: 44 }} dpr={[1, 2]} onPointerMissed={() => props.onSelect(null)} style={{ position: "absolute", inset: 0 }}>
      <color attach="background" args={[props.dark ? "#0a0a0a" : "#fafafa"]} />
      <fog attach="fog" args={[props.dark ? "#0a0a0a" : "#fafafa", 14, 30]} />
      <Content {...props} />
    </Canvas>
  );
}
