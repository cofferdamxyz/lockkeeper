"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { useMemo, useRef, useState } from "react";
import type { Mesh } from "three";

import { dirColor, type PositionView, STATUS_COLOR, type StateView, type TaskView } from "../lib/api";

const SCALE = 2.6;
const GATE: [number, number, number] = [3.6, 0.2, 0];

function toScene(p: PositionView): [number, number, number] {
  return [p.x * SCALE, p.y * SCALE, p.z * SCALE];
}

function FileNode({ p, onSelect, hovered, setHovered }: { p: PositionView; onSelect: (id: string) => void; hovered: boolean; setHovered: (id: string | null) => void }) {
  return (
    <mesh
      position={toScene(p)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(p.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(p.id);
      }}
      onPointerOut={() => setHovered(null)}
    >
      <sphereGeometry args={[hovered ? 0.07 : 0.045, 16, 16]} />
      <meshStandardMaterial color={dirColor(p.meta?.dir)} emissive={dirColor(p.meta?.dir)} emissiveIntensity={hovered ? 0.9 : 0.25} />
      {hovered && (
        <Html distanceFactor={8} style={{ pointerEvents: "none" }}>
          <div className="label">{p.label}</div>
        </Html>
      )}
    </mesh>
  );
}

function TaskNode({ task, position, selected, onSelect }: { task: TaskView; position: [number, number, number]; selected: boolean; onSelect: (id: string) => void }) {
  const ref = useRef<Mesh>(null);
  const color = STATUS_COLOR[task.status];
  const target = task.status === "merging" || task.status === "approved" ? GATE : position;
  const faded = task.status === "merged" || task.status === "abandoned" || task.status === "failed";
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    // Glide toward the gate while merging, back to the map otherwise.
    m.position.x += (target[0] - m.position.x) * 0.04;
    m.position.y += (target[1] - m.position.y) * 0.04;
    m.position.z += (target[2] - m.position.z) * 0.04;
    const pulse = task.status === "running" ? 1 + Math.sin(clock.elapsedTime * 3) * 0.18 : 1;
    const base = selected ? 1.35 : 1;
    m.scale.setScalar(pulse * base);
  });
  return (
    <mesh
      ref={ref}
      position={position}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(task.id);
      }}
    >
      <sphereGeometry args={[faded ? 0.075 : 0.12, 24, 24]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={faded ? 0.15 : 0.8} transparent opacity={faded ? 0.45 : 1} />
      {(selected || (!faded && task.status !== "queued")) && (
        <Html distanceFactor={9} style={{ pointerEvents: "none" }}>
          <div className={`label task ${task.status}`}>
            <span className="dot" style={{ background: color }} /> {task.id.slice(-4)} · {task.goal.slice(0, 48)}
            {task.goal.length > 48 ? "…" : ""}
          </div>
        </Html>
      )}
    </mesh>
  );
}

function Gate() {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.rotation.y = clock.elapsedTime * 0.3;
  });
  return (
    <group position={GATE}>
      <mesh ref={ref}>
        <torusGeometry args={[0.55, 0.035, 16, 80]} />
        <meshStandardMaterial color="#3C8AFF" emissive="#3C8AFF" emissiveIntensity={0.9} />
      </mesh>
      <Html distanceFactor={9} position={[0, -0.85, 0]} style={{ pointerEvents: "none" }}>
        <div className="label gate">merge gate · main</div>
      </Html>
    </group>
  );
}

export default function Scene({ state, selected, onSelect }: { state: StateView; selected: string | null; onSelect: (id: string | null) => void }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const files = useMemo(() => state.positions.filter((p) => p.kind === "file"), [state.positions]);
  const taskPositions = useMemo(() => {
    const map = new Map<string, [number, number, number]>();
    for (const p of state.positions) if (p.kind === "task" && p.meta?.task) map.set(p.meta.task, toScene(p));
    return map;
  }, [state.positions]);
  const tasks = state.tasks.filter((t) => taskPositions.has(t.id));
  const edges = state.edges
    .map((e) => ({ ...e, a: taskPositions.get(e.a), b: taskPositions.get(e.b) }))
    .filter((e) => e.a && e.b) as { a: [number, number, number]; b: [number, number, number]; cosine: number; paths: number }[];

  return (
    <Canvas camera={{ position: [0.5, 2.4, 6.2], fov: 48 }} onPointerMissed={() => onSelect(null)} dpr={[1, 2]}>
      <color attach="background" args={["#0b1020"]} />
      <ambientLight intensity={0.7} />
      <pointLight position={[6, 6, 6]} intensity={1.4} />
      <pointLight position={[-6, -2, -4]} intensity={0.5} color="#3C8AFF" />
      <Grid args={[24, 24]} cellColor="#131d33" sectionColor="#1b2a4a" fadeDistance={16} position={[0, -1.8, 0]} infiniteGrid />
      {files.map((p) => (
        <FileNode key={p.id} p={p} onSelect={onSelect} hovered={hovered === p.id} setHovered={setHovered} />
      ))}
      {edges.map((e, i) => {
        const strength = Math.max(e.cosine, e.paths);
        const color = strength > 0.7 ? "#ff5d5d" : strength > 0.45 ? "#ff9f43" : "#f2c14e";
        return <Line key={i} points={[e.a, e.b]} color={color} lineWidth={1 + strength * 3} transparent opacity={0.85} />;
      })}
      {tasks.map((t) => (
        <TaskNode key={t.id} task={t} position={taskPositions.get(t.id)!} selected={selected === t.id} onSelect={onSelect} />
      ))}
      <Gate />
      <OrbitControls enablePan={false} autoRotate autoRotateSpeed={0.35} minDistance={2.5} maxDistance={14} makeDefault />
    </Canvas>
  );
}
