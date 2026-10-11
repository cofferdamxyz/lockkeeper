"use client";

import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { Color, type Group, type Mesh } from "three";

import { type ActivityEvent, type StateView, type TaskView } from "@/lib/api";
import { arcPoints, type Bead, beadRadius, type Branch, computeRings, hoverHeight, LANE_GAP, MAIN_RADIUS, orbitRing, type RingLayout, statusColor, type Vec3 } from "@/lib/rings";

export interface SceneProps {
  state: StateView;
  selected: string | null;
  hovered: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  activity: Record<string, ActivityEvent[]>;
  dark: boolean;
  /** The moment the scene shows; replay passes a past time. */
  now: number;
  focus?: string | null;
  compact?: boolean;
}

const BLUE = "#1370f2";
const GRID = 16;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function Grid({ size, dark }: { size: number; dark: boolean }) {
  const half = size / 2;
  const color = (i: number) => {
    const t = Math.abs(i) / half;
    if (dark) {
      const l = lerp(0.095, 0.06, t);
      return new Color(l, l * 1.15, l * 1.5);
    }
    const l = lerp(0.82, 0.9, t);
    return new Color(l, l * 1.005, l * 1.02);
  };
  const lines = useMemo(() => {
    const out: { key: string; points: [Vec3, Vec3]; i: number }[] = [];
    for (let k = 0; k <= size; k++) {
      const i = -half + k;
      out.push({ key: `x${k}`, points: [[i, -1.6, half], [i, -1.6, -half]], i });
      out.push({ key: `z${k}`, points: [[half, -1.6, i], [-half, -1.6, i]], i });
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

function Spoke({ from, to, color, opacity = 0.7, dashed = false }: { from: Vec3; to: Vec3; color: string; opacity?: number; dashed?: boolean }) {
  return <Line points={[from, to]} color={color} lineWidth={1.4} transparent opacity={opacity} dashed={dashed} dashSize={0.08} gapSize={0.06} />;
}

function BeadPoint({ bead, lit, dim, showSeq, onSelect, onHover }: { bead: Bead; lit: boolean; dim: boolean; showSeq: boolean; onSelect: (id: string) => void; onHover: (id: string | null) => void }) {
  const ref = useRef<Mesh>(null);
  const born = useRef<number | null>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    if (born.current === null) born.current = clock.elapsedTime;
    const k = Math.min(1, (clock.elapsedTime - born.current) / 0.6);
    m.scale.setScalar((1 - Math.pow(1 - k, 3)) * (lit ? 1.7 : 1));
  });
  return (
    <mesh
      ref={ref}
      position={bead.pos}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(bead.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(bead.id);
      }}
      onPointerOut={() => onHover(null)}
    >
      <sphereGeometry args={[beadRadius(bead), 14, 14]} />
      <meshPhongMaterial color={BLUE} emissive={BLUE} emissiveIntensity={lit ? 1 : dim ? 0.1 : 0.35} transparent opacity={dim ? 0.45 : 1} />
      {showSeq && bead.seq !== null && !lit && (
        <Html distanceFactor={10} center position={[0, 0.22, 0]} style={{ pointerEvents: "none" }}>
          <div className="scene-seq">{bead.seq}</div>
        </Html>
      )}
      {lit && (
        <Html distanceFactor={12} style={{ pointerEvents: "none" }}>
          <div className="scene-label">
            {bead.seq !== null && <span className="scene-seq inline">{bead.seq}</span>}
            <span className="mono text-blue-400">{bead.sha.slice(0, 7)}</span> {bead.label.slice(0, 60)}
            {bead.files.length > 0 && <span className="text-muted-foreground"> · {bead.files.length} file{bead.files.length === 1 ? "" : "s"}</span>}
          </div>
        </Html>
      )}
    </mesh>
  );
}

function Agent({ branch, now, selected, hovered, focus, acts, onSelect, onHover }: { branch: Branch; now: number; selected: boolean; hovered: boolean; focus: boolean; acts: ActivityEvent[]; onSelect: (id: string) => void; onHover: (id: string | null) => void }) {
  const ref = useRef<Group>(null);
  const task = branch.task;
  const color = statusColor(task.status);
  const merging = task.status === "merging" || task.status === "approved";
  const height = hoverHeight(task, now);
  const target = useMemo<Vec3>(() => {
    if (merging) return [branch.base[0] * 0.4, 0.3, branch.base[2] * 0.4];
    const n = branch.normal;
    return [branch.tip[0] + n[0] * height, branch.tip[1] + n[1] * height, branch.tip[2] + n[2] * height];
  }, [branch.tip, branch.base, branch.normal, height, merging]);
  const [pos, setPos] = useState<Vec3>(target);
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g) return;
    g.position.x += (target[0] - g.position.x) * 0.06;
    g.position.y += (target[1] - g.position.y) * 0.06;
    g.position.z += (target[2] - g.position.z) * 0.06;
    const pulse = task.status === "running" ? 1 + Math.sin(clock.elapsedTime * 3) * 0.14 : 1;
    g.scale.setScalar(pulse * (selected || hovered || focus ? 1.35 : 1));
    if (Math.abs(g.position.x - pos[0]) + Math.abs(g.position.y - pos[1]) + Math.abs(g.position.z - pos[2]) > 0.02) setPos([g.position.x, g.position.y, g.position.z]);
  });
  const lit = selected || hovered || focus;
  const ticks = acts.filter((a) => a.kind === "tool").slice(-8);
  return (
    <>
      {!merging && height > 0.05 && <Spoke from={branch.tip} to={pos} color={color} opacity={0.45} />}
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
          <sphereGeometry args={[0.14, 20, 20]} />
          <meshPhongMaterial color={color} emissive={color} emissiveIntensity={0.7} />
        </mesh>
        {task.status === "running" && (
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.25, 0.012, 8, 48]} />
            <meshBasicMaterial color={BLUE} />
          </mesh>
        )}
        {task.status === "needs_review" && (
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.25, 0.01, 8, 48]} />
            <meshBasicMaterial color="#f5b94a" transparent opacity={0.8} />
          </mesh>
        )}
        {ticks.map((a, i) => {
          const ang = (i / 8) * Math.PI * 2;
          const c = a.kind === "tool" && a.name === "Bash" ? BLUE : a.kind === "tool" && (a.name === "Edit" || a.name === "Write") ? "#ffffff" : "#8a97b3";
          return (
            <mesh key={i} position={[Math.cos(ang) * 0.36, 0, Math.sin(ang) * 0.36]}>
              <sphereGeometry args={[0.022, 8, 8]} />
              <meshBasicMaterial color={c} />
            </mesh>
          );
        })}
        {(lit || task.status !== "queued") && (
          <Html distanceFactor={12} position={[0.22, 0, 0]} style={{ pointerEvents: "none" }}>
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

function MainRing({ busy, head }: { busy: boolean; head: string | null }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.rotation.z = clock.elapsedTime * (busy ? 1 : 0.1);
  });
  return (
    <group>
      <mesh ref={ref} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[MAIN_RADIUS, 0.035, 16, 128]} />
        <meshPhongMaterial color={BLUE} emissive={BLUE} emissiveIntensity={busy ? 1.1 : 0.45} />
      </mesh>
      <Html distanceFactor={9} position={[0, 0.02, 0]} center style={{ pointerEvents: "none" }}>
        <div className="scene-label gate" style={{ transform: "none" }}>
          main <span className="mono">{head ? head.slice(0, 7) : "—"}</span>
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
    const k = (clock.elapsedTime - t0) / 1.8;
    if (k >= 1) {
      onDone();
      return;
    }
    m.scale.setScalar(1 + k * 6);
    (m.material as { opacity: number }).opacity = (1 - k) * 0.5;
  });
  return (
    <mesh ref={ref} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
      <torusGeometry args={[MAIN_RADIUS, 0.012, 8, 96]} />
      <meshBasicMaterial color={BLUE} transparent opacity={0.5} />
    </mesh>
  );
}

function Content({ state, selected, hovered, onSelect, onHover, activity, dark, now, focus, compact }: SceneProps) {
  const layout: RingLayout = useMemo(() => computeRings(state, now), [state, now]);
  const merging = state.tasks.some((t) => t.status === "merging" || t.status === "approved");
  const clockRef = useRef(0);
  const [ripples, setRipples] = useState<number[]>([]);
  const prevMerged = useRef<Set<string> | null>(null);
  useFrame(({ clock }) => {
    clockRef.current = clock.elapsedTime;
  });
  useEffect(() => {
    const merged = new Set(state.tasks.filter((t) => t.status === "merged").map((t) => t.id));
    if (prevMerged.current) for (const id of merged) if (!prevMerged.current.has(id)) setRipples((r) => [...r, clockRef.current]);
    prevMerged.current = merged;
  }, [state.tasks]);

  const picked = selected ?? hovered;
  const pickedTask = state.tasks.find((t) => t.id === picked) ?? null;
  const pickedBead = layout.beads.find((b) => b.id === picked) ?? null;
  // A file picked from a panel has no place in the space; the commits that touched it light up.
  const pickedFile = picked && picked.startsWith("file:") ? (state.positions.find((p) => p.id === picked)?.label ?? null) : null;
  const litTask = pickedTask?.id ?? pickedBead?.task ?? focus ?? null;
  const litBeadIds = new Set<string>(pickedFile ? layout.beads.filter((b) => b.files.includes(pickedFile)).map((b) => b.id) : []);
  const tickColor = dark ? "#3a4a66" : "#b7bfcc";

  return (
    <>
      <ambientLight intensity={Math.PI / 2} />
      <spotLight position={[10, 12, 10]} angle={0.2} penumbra={1} decay={0} intensity={Math.PI} />
      <pointLight position={[-10, -6, -10]} decay={0} intensity={Math.PI * 0.6} />
      <Grid size={GRID} dark={dark} />

      {/* orbital planes: a faint full ring for every live branch and for the lit one */}
      {layout.branches
        .filter((b) => b.live || litTask === b.task.id)
        .map((b) => (
          <Line key={`orbit-${b.task.id}`} points={orbitRing(b)} color={litTask === b.task.id ? "#ffffff" : dark ? "#2a3a5c" : "#c9d1de"} lineWidth={1} transparent opacity={litTask === b.task.id ? 0.35 : 0.5} />
        ))}

      {/* branches: arc, base spoke, merge spoke */}
      {layout.branches.map((b) => {
        const t = b.task;
        const isLit = litTask === t.id;
        const dim = litTask !== null && !isLit;
        const color = b.conflict ? "#ff1919" : isLit ? "#ffffff" : t.status === "merged" ? "#5a86c7" : statusColor(t.status);
        const pts = arcPoints(b, b.uStart, b.uEnd);
        const tip = pts[pts.length - 1];
        const prev = pts[Math.max(0, pts.length - 2)];
        const d: Vec3 = [tip[0] - prev[0], tip[1] - prev[1], tip[2] - prev[2]];
        const dl = Math.hypot(d[0], d[1], d[2]) || 1;
        const f: Vec3 = [d[0] / dl, d[1] / dl, d[2] / dl];
        const n = b.normal;
        // the side vector lies in the orbital plane: normal × forward
        const sd: Vec3 = [n[1] * f[2] - n[2] * f[1], n[2] * f[0] - n[0] * f[2], n[0] * f[1] - n[1] * f[0]];
        const ah = 0.16;
        const left: Vec3 = [tip[0] - f[0] * ah - sd[0] * ah * 0.5, tip[1] - f[1] * ah - sd[1] * ah * 0.5, tip[2] - f[2] * ah - sd[2] * ah * 0.5];
        const right: Vec3 = [tip[0] - f[0] * ah + sd[0] * ah * 0.5, tip[1] - f[1] * ah + sd[1] * ah * 0.5, tip[2] - f[2] * ah + sd[2] * ah * 0.5];
        return (
          <group key={t.id}>
            <Line points={pts} color={color} lineWidth={isLit ? 2.6 : b.live ? 2 : 1.4} transparent opacity={dim ? 0.25 : t.status === "merged" ? 0.75 : 1} />
            {b.live && <Line points={[left, tip, right]} color={color} lineWidth={isLit ? 2.6 : 2} transparent opacity={dim ? 0.25 : 1} />}
            <Spoke from={b.base} to={pts[0]} color={color} opacity={dim ? 0.15 : 0.5} />
            {b.mergeOnMain && <Spoke from={pts[pts.length - 1]} to={b.mergeOnMain} color={color} opacity={dim ? 0.15 : 0.7} />}
            {t.status === "needs_review" && <Spoke from={pts[pts.length - 1]} to={layout.ringPoint(MAIN_RADIUS, layout.tEnd)} color="#f5b94a" opacity={0.6} dashed />}
            {!compact && isLit && t.status === "merged" && (
              <Html position={pts[Math.floor(pts.length / 2)]} distanceFactor={10} center style={{ pointerEvents: "none" }}>
                <div className="scene-label">
                  <span className="mono">{t.id.slice(-4)}</span> {t.goal.slice(0, 40)}
                </div>
              </Html>
            )}
          </group>
        );
      })}

      {/* hour marks along main */}
      {layout.ticks.map((tk) => (
        <group key={tk.at}>
          <Spoke from={layout.ringPoint(MAIN_RADIUS - 0.12, tk.at)} to={layout.ringPoint(MAIN_RADIUS - 0.02, tk.at)} color={tickColor} opacity={1} />
          {!compact && (
            <Html position={layout.ringPoint(MAIN_RADIUS - 0.42, tk.at, 0)} distanceFactor={10} center style={{ pointerEvents: "none" }}>
              <div className="scene-tick">{tk.label}</div>
            </Html>
          )}
        </group>
      ))}

      {/* beads: every commit, sized by the files it changed */}
      {layout.beads.map((bead) => {
        const lit = picked === bead.id || litBeadIds.has(bead.id) || (!!litTask && bead.task === litTask && !!pickedTask);
        const dim = (litTask !== null && bead.task !== litTask && picked !== bead.id) || (litBeadIds.size > 0 && !litBeadIds.has(bead.id));
        return <BeadPoint key={bead.id} bead={bead} lit={lit} dim={dim} showSeq={!!litTask && bead.task === litTask} onSelect={onSelect} onHover={onHover} />;
      })}

      {/* agents on live arcs */}
      {layout.branches
        .filter((b) => b.live && !["merged", "abandoned", "failed"].includes(b.task.status))
        .map((b) => (
          <Agent key={b.task.id} branch={b} now={now} selected={selected === b.task.id} hovered={hovered === b.task.id} focus={focus === b.task.id} acts={activity[b.task.id] ?? []} onSelect={onSelect} onHover={onHover} />
        ))}

      {/* overlap between in-flight work */}
      {state.edges.map((e, i) => {
        const a = layout.branches.find((b) => b.task.id === e.a);
        const b = layout.branches.find((x) => x.task.id === e.b);
        if (!a || !b) return null;
        const s = Math.max(e.cosine, e.paths);
        const ha = hoverHeight(a.task, now);
        const hb = hoverHeight(b.task, now);
        const pa: Vec3 = [a.tip[0] + a.normal[0] * ha, a.tip[1] + a.normal[1] * ha, a.tip[2] + a.normal[2] * ha];
        const pb: Vec3 = [b.tip[0] + b.normal[0] * hb, b.tip[1] + b.normal[1] * hb, b.tip[2] + b.normal[2] * hb];
        return <Line key={i} points={[pa, pb]} color={s > 0.7 ? "#ff1919" : s > 0.45 ? "#f5b94a" : "#8a97b3"} lineWidth={1 + s * 2} transparent opacity={0.7} />;
      })}

      <MainRing busy={merging} head={state.project?.head ?? null} />
      {/* now marker: the gap in the circle */}
      <Spoke from={layout.ringPoint(MAIN_RADIUS, layout.tEnd)} to={layout.ringPoint(MAIN_RADIUS + LANE_GAP * (Math.max(layout.lanes, 1) + 0.6), layout.tEnd)} color={dark ? "#2b3a55" : "#c9d0dc"} opacity={0.9} dashed />
      {ripples.map((t0, i) => (
        <Ripple key={`${t0}-${i}`} t0={t0} onDone={() => setRipples((r) => r.filter((x) => x !== t0))} />
      ))}
      <OrbitControls rotateSpeed={0.3} enablePan={false} enableZoom minDistance={4} maxDistance={30} autoRotate={!selected && !hovered} autoRotateSpeed={0.5} enableDamping dampingFactor={0.08} makeDefault />
    </>
  );
}

export default function Scene(props: SceneProps) {
  const dist = props.compact ? 9 : 11.5;
  const angle = (38 * Math.PI) / 180;
  return (
    <Canvas camera={{ position: [0, Math.sin(angle) * dist, Math.cos(angle) * dist], fov: 45 }} dpr={[1, 2]} onPointerMissed={() => props.onSelect(null)} style={{ position: "absolute", inset: 0 }}>
      <color attach="background" args={[props.dark ? "#090d13" : "#f7f8fb"]} />
      <Content {...props} />
    </Canvas>
  );
}
