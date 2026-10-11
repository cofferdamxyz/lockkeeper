"use client";

import { CanvasSpace, Create, Group, Num, Pt, Shaping } from "pts";
import { useEffect, useRef } from "react";

import type { ActivityEvent, PositionView, StateView, TaskStatus, TaskView } from "@/lib/api";
import { isLive } from "@/lib/api";

export interface ChartProps {
  state: StateView | null;
  selected: string | null;
  hovered: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  /** Latest parsed activity per live task, for the ticks around a node. */
  activity: Record<string, ActivityEvent[]>;
  /** Where new nodes are born on screen (the launcher), in CSS pixels. */
  birthAt: { x: number; y: number } | null;
  dark: boolean;
}

interface Node {
  id: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  r: number;
  born: number;
  trail: { x: number; y: number }[];
  exit?: number;
}

interface Ripple {
  x: number;
  y: number;
  t0: number;
}

const DEPTH = 0.55;

function hashColor(key: string, dark: boolean): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return dark ? `oklch(0.78 0.08 ${hue})` : `oklch(0.52 0.1 ${hue})`;
}

/**
 * The index drawn as a chart. Model coordinates come from the Worker's projection; the view
 * maps them to the screen with pan, zoom and a little parallax by depth. Tasks are nodes that
 * glide toward their targets; the lock on the right edge stages every merge.
 */
export default function Chart({ state, selected, hovered, onSelect, onHover, activity, birthAt, dark }: ChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<StateView | null>(state);
  const selectedRef = useRef(selected);
  const hoveredRef = useRef(hovered);
  const activityRef = useRef(activity);
  const birthRef = useRef(birthAt);
  const darkRef = useRef(dark);
  const nodes = useRef(new Map<string, Node>());
  const statuses = useRef(new Map<string, TaskStatus>());
  const ripples = useRef<Ripple[]>([]);
  const gate = useRef({ left: 0, right: 0, fill: 0, busy: 0 });
  const view = useRef({ x: 0, y: 0, zoom: 1 });
  const handlers = useRef({ onSelect, onHover });

  stateRef.current = state;
  selectedRef.current = selected;
  hoveredRef.current = hovered;
  activityRef.current = activity;
  birthRef.current = birthAt;
  darkRef.current = dark;
  handlers.current = { onSelect, onHover };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const space = new CanvasSpace(canvas).setup({ bgcolor: "transparent", resize: true, retina: true });
    const form = space.getForm();
    let screenFiles: { id: string; label: string; dir: string; x: number; y: number; z: number }[] = [];
    let cells: Group[] = [];
    let cellKey = "";
    let dragging: { x: number; y: number; moved: boolean; vx: number; vy: number } | null = null;

    const ink = (a: number) => (darkRef.current ? `rgba(255,255,255,${a})` : `rgba(10,10,12,${a})`);
    const accent = () => (darkRef.current ? "#3b82f6" : "#1d4ed8");
    const warn = () => (darkRef.current ? "#f5b94a" : "#b4720a");
    const danger = () => (darkRef.current ? "#f87171" : "#b91c1c");

    const geometry = () => {
      const w = space.width;
      const h = space.height;
      const gateX = w - Math.min(170, w * 0.14);
      const cy = h * 0.5;
      return { w, h, gateX, cy, chamber: { x1: gateX - 62, x2: gateX + 62, y1: cy - 54, y2: cy + 54 }, scale: Math.min(w * 0.62, h) * 0.46, cx: w * 0.4, mainX: gateX + 118 };
    };

    const toScreen = (mx: number, my: number, mz: number) => {
      const g = geometry();
      const v = view.current;
      const depth = 1 + mz * DEPTH;
      return {
        x: g.cx + (mx - v.x * depth) * g.scale * v.zoom,
        y: g.cy + (-my - v.y * depth) * g.scale * v.zoom,
      };
    };

    const rebuild = () => {
      const s = stateRef.current;
      if (!s) return;
      const g = geometry();
      screenFiles = s.positions
        .filter((p) => p.kind === "file")
        .map((p) => {
          const { x, y } = toScreen(p.x, p.y, p.z);
          return { id: p.id, label: p.label, dir: p.meta?.dir ?? ".", x, y, z: p.z };
        });
      const key = `${screenFiles.length}:${view.current.x.toFixed(2)}:${view.current.y.toFixed(2)}:${view.current.zoom.toFixed(2)}:${g.w}x${g.h}:${screenFiles.map((f) => f.id).join("|").length}`;
      if (key !== cellKey && screenFiles.length >= 3) {
        cellKey = key;
        try {
          // Delaunay needs distinct points; files that project onto each other get a deterministic nudge.
          const seen = new Set<string>();
          const pts = Group.fromArray(
            screenFiles.map((f, i) => {
              let x = f.x;
              let y = f.y;
              let k = `${Math.round(x)}:${Math.round(y)}`;
              while (seen.has(k)) {
                x += 1.5 + (i % 3);
                y += 1 + (i % 2);
                k = `${Math.round(x)}:${Math.round(y)}`;
              }
              seen.add(k);
              return [x, y];
            }),
          );
          const bound = Group.fromArray([[0, 0], [g.gateX - 90, g.h]]);
          const mesh = Create.delaunay(pts);
          mesh.delaunay(); // caches the triangulation that voronoi() reads
          cells = mesh.voronoi(bound);
        } catch (e) {
          console.warn("voronoi failed", e);
          cells = [];
        }
      }
    };

    const nodeTarget = (t: TaskView, pos: PositionView | undefined) => {
      const g = geometry();
      if (t.status === "merging" || t.status === "approved") return { x: (g.chamber.x1 + g.chamber.x2) / 2, y: g.cy };
      if (t.status === "needs_review") return { x: g.chamber.x1 - 46, y: g.cy + 2 };
      if (pos) return toScreen(pos.x, pos.y, pos.z);
      return { x: g.cx, y: g.cy };
    };

    const drawNodeShape = (n: Node, t: TaskView, now: number, g: ReturnType<typeof geometry>) => {
      const isSel = selectedRef.current === t.id;
      const isHov = hoveredRef.current === t.id;
      const base = n.r * (isSel ? 1.3 : 1) * (isHov ? 1.15 : 1);
      const p = new Pt(n.x, n.y);
      // trail
      if (n.trail.length > 1) {
        form.strokeOnly(ink(0.18), 1).line(Group.fromArray(n.trail.map((q) => [q.x, q.y])));
      }
      switch (t.status) {
        case "queued":
          form.strokeOnly(ink(0.5), 1.2).fillOnly(false).point(p, base, "circle");
          break;
        case "running": {
          const breathe = 1 + Math.sin(now / 420) * 0.12;
          form.fillOnly(ink(0.95)).point(p, base * 0.72, "circle");
          form.strokeOnly(accent(), 1.6).alpha(0.9).point(p, base * breathe + 4, "circle");
          form.alpha(1);
          break;
        }
        case "ready":
          form.fillOnly(ink(0.95)).point(p, base, "circle");
          form.strokeOnly(accent(), 1).point(p, base + 5, "circle");
          break;
        case "merging":
        case "approved":
          form.fillOnly(accent()).point(p, base, "circle");
          break;
        case "needs_review":
          form.fillOnly(ink(0.9)).point(p, base * 0.8, "circle");
          form.dash([3, 3]).strokeOnly(warn(), 1.4).point(p, base + 5, "circle").dash(false);
          break;
        case "blocked":
          form.fillOnly(ink(0.6)).point(p, base, "circle");
          form.strokeOnly(ink(0.9), 2).line(Group.fromArray([[n.x - base, n.y], [n.x + base, n.y]]));
          break;
        case "failed":
          form.strokeOnly(danger(), 1.4).point(p, base * 0.9, "circle");
          form.strokeOnly(danger(), 1.4).line(Group.fromArray([[n.x - base * 0.55, n.y - base * 0.55], [n.x + base * 0.55, n.y + base * 0.55]]));
          break;
        case "merged":
          form.fillOnly(ink(0.35)).point(p, base * 0.55, "circle");
          break;
        case "abandoned":
          form.fillOnly(ink(0.18)).point(p, base * 0.45, "circle");
          break;
      }
      // activity ticks around live nodes
      const acts = activityRef.current[t.id];
      if (acts && isLive(t.status)) {
        const recent = acts.filter((a) => a.kind === "tool").slice(-8);
        recent.forEach((a, i) => {
          const ang = -Math.PI / 2 + (i / 8) * Math.PI * 2;
          const rr = base + 11;
          const q = [n.x + Math.cos(ang) * rr, n.y + Math.sin(ang) * rr];
          const c = a.kind === "tool" && a.name === "Bash" ? accent() : a.kind === "tool" && (a.name === "Edit" || a.name === "Write" || a.name === "MultiEdit") ? ink(0.95) : ink(0.45);
          form.fillOnly(c).point(new Pt(q), 1.6, "circle");
        });
      }
      if (isSel || isHov || (isLive(t.status) && t.status !== "queued")) {
        form.font(11, "normal", "normal", 1, "ui-monospace, Menlo, monospace");
        form.fillOnly(ink(isSel || isHov ? 0.95 : 0.7));
        const label = `${t.id.slice(-4)}  ${t.goal.slice(0, 44)}${t.goal.length > 44 ? "…" : ""}`;
        form.text(new Pt(n.x + base + 10, n.y + 4), label);
      }
      void g;
    };

    const drawGate = (g: ReturnType<typeof geometry>, now: number, s: StateView) => {
      const c = g.chamber;
      const gt = gate.current;
      // chamber
      form.strokeOnly(ink(0.35), 1).polygon(Group.fromArray([[c.x1, c.y1], [c.x2, c.y1], [c.x2, c.y2], [c.x1, c.y2]]));
      // fill while a merge is in progress
      if (gt.fill > 0.01) {
        const level = c.y2 - (c.y2 - c.y1) * gt.fill;
        form.fillOnly(darkRef.current ? "rgba(59,130,246,0.14)" : "rgba(29,78,216,0.12)").rect(Group.fromArray([[c.x1 + 1, level], [c.x2 - 1, c.y2 - 1]]));
      }
      // gates: two halves that retract when open
      const gap = (open: number) => ((c.y2 - c.y1) / 2) * open;
      for (const [x, open] of [[c.x1, gt.left], [c.x2, gt.right]] as [number, number][]) {
        form.strokeOnly(gt.busy > 0 ? accent() : ink(0.8), 2);
        if (open < 0.03) {
          form.line(Group.fromArray([[x, c.y1 - 6], [x, c.y2 + 6]]));
        } else {
          const gp = gap(open);
          form.line(Group.fromArray([[x, c.y1 - 6], [x, g.cy - gp - 2]]));
          form.line(Group.fromArray([[x, g.cy + gp + 2], [x, c.y2 + 6]]));
        }
      }
      // main
      form.strokeOnly(ink(0.5), 1.4).line(Group.fromArray([[g.mainX, c.y1 - 40], [g.mainX, c.y2 + 40]]));
      form.font(10, "normal", "normal", 1, "ui-monospace, Menlo, monospace").fillOnly(ink(0.6));
      form.text(new Pt(g.mainX - 14, c.y1 - 50), "main");
      form.text(new Pt(g.mainX - 24, c.y2 + 62), s.project?.head ? s.project.head.slice(0, 7) : "—");
      form.font(10, "normal", "normal", 1, "ui-monospace, Menlo, monospace").fillOnly(ink(0.45));
      form.text(new Pt(c.x1 - 2, c.y2 + 22), "merge gate");
      // ripples
      const keep: Ripple[] = [];
      for (const r of ripples.current) {
        const t = (now - r.t0) / 1800;
        if (t < 1) {
          keep.push(r);
          const rad = 20 + Shaping.quadraticOut(t) * Math.max(g.w, g.h) * 0.7;
          form.strokeOnly(accent(), 1.2).alpha((1 - t) * 0.5).point(new Pt(r.x, r.y), rad, "circle");
          form.alpha(1);
        }
      }
      ripples.current = keep;
    };

    space.add({
      start: () => rebuild(),
      animate: (time) => {
        const s = stateRef.current;
        const now = time ?? performance.now();
        const g = geometry();
        if (!s) return;
        rebuild();
        // territories
        form.strokeOnly(ink(0.16), 1);
        for (const cell of cells) if (cell.length > 2) form.polygon(cell);
        // directory labels
        const dirs = new Map<string, { x: number; y: number; n: number }>();
        for (const f of screenFiles) {
          const d = dirs.get(f.dir) ?? { x: 0, y: 0, n: 0 };
          d.x += f.x;
          d.y += f.y;
          d.n += 1;
          dirs.set(f.dir, d);
        }
        form.font(10, "normal", "normal", 1, "ui-monospace, Menlo, monospace");
        const ctx = form.ctx as CanvasRenderingContext2D & { letterSpacing?: string };
        if ("letterSpacing" in ctx) ctx.letterSpacing = "0.16em";
        for (const [dir, d] of dirs) {
          form.fillOnly(ink(0.5)).text(new Pt(d.x / d.n - 12, d.y / d.n - 18), dir.toUpperCase());
        }
        if ("letterSpacing" in ctx) ctx.letterSpacing = "0em";
        // files
        for (const f of screenFiles) {
          const isHov = hoveredRef.current === f.id;
          const isSel = selectedRef.current === f.id;
          const r = (2.2 + (f.z + 1) * 1.2) * (isHov || isSel ? 1.8 : 1);
          form.fillOnly(hashColor(f.dir, darkRef.current)).alpha(isHov || isSel ? 1 : 0.75).point(new Pt(f.x, f.y), r, "circle");
          form.alpha(1);
          if (isHov || isSel) {
            form.font(11, "normal", "normal", 1, "ui-monospace, Menlo, monospace").fillOnly(ink(0.9)).text(new Pt(f.x + 9, f.y + 4), f.label);
          }
        }
        // nodes: update targets
        const positions = new Map<string, PositionView>();
        for (const p of s.positions) if (p.kind === "task" && p.meta?.task) positions.set(p.meta.task, p);
        const liveIds = new Set<string>();
        let merging: TaskView | null = null;
        let waiting = false;
        for (const t of s.tasks) {
          liveIds.add(t.id);
          let n = nodes.current.get(t.id);
          const target = nodeTarget(t, positions.get(t.id));
          if (!n) {
            const b = birthRef.current;
            const start = b && t.status === "queued" ? { x: b.x, y: b.y } : target;
            n = { id: t.id, x: start.x, y: start.y, tx: target.x, ty: target.y, r: 7, born: now, trail: [] };
            nodes.current.set(t.id, n);
          }
          const prev = statuses.current.get(t.id);
          if (prev !== t.status) {
            statuses.current.set(t.id, t.status);
            if (t.status === "merged" && prev && prev !== "merged") {
              const c = g.chamber;
              ripples.current.push({ x: (c.x1 + c.x2) / 2, y: g.cy, t0: now });
              n.exit = now;
            }
          }
          n.tx = target.x;
          n.ty = target.y;
          // exit through the far gate, then settle on the map
          if (n.exit && now - n.exit < 900) {
            const k = (now - n.exit) / 900;
            const c = g.chamber;
            n.tx = Num.lerp((c.x1 + c.x2) / 2, g.mainX, Shaping.quadraticInOut(k));
            n.ty = g.cy;
          }
          const ease = isLive(t.status) ? 0.08 : 0.05;
          const dx = n.tx - n.x;
          const dy = n.ty - n.y;
          n.x += dx * ease;
          n.y += dy * ease;
          if (Math.abs(dx) + Math.abs(dy) > 1.5 && isLive(t.status)) {
            n.trail.push({ x: n.x, y: n.y });
            if (n.trail.length > 24) n.trail.shift();
          } else if (n.trail.length) n.trail.shift();
          n.r = t.status === "merged" || t.status === "abandoned" ? 5 : 7;
          if (t.status === "merging" || t.status === "approved") merging = t;
          if (t.status === "needs_review") waiting = true;
        }
        for (const id of [...nodes.current.keys()]) if (!liveIds.has(id)) nodes.current.delete(id);
        // gate state
        const gt = gate.current;
        const c = g.chamber;
        const inChamber = merging ? nodes.current.get(merging.id) : null;
        const approaching = inChamber ? Math.abs(inChamber.x - (c.x1 + c.x2) / 2) > 10 : false;
        const leftTarget = merging && approaching ? 1 : waiting ? 0 : 0;
        const rightTarget = [...nodes.current.values()].some((n) => n.exit && now - n.exit < 900) ? 1 : 0;
        gt.left += (leftTarget - gt.left) * 0.12;
        gt.right += (rightTarget - gt.right) * 0.14;
        gt.fill += ((merging && !approaching ? 0.5 + Math.sin(now / 600) * 0.15 : 0) - gt.fill) * 0.06;
        gt.busy = merging ? 1 : 0;
        // edges
        const byId = new Map(s.tasks.map((t) => [t.id, t]));
        for (const e of s.edges) {
          const a = nodes.current.get(e.a);
          const b = nodes.current.get(e.b);
          if (!a || !b) continue;
          const strength = Math.max(e.cosine, e.paths);
          const conflict = s.merges.some((m) => (m.task_id === e.a || m.task_id === e.b) && m.conflict && !m.resolved_by && byId.get(m.task_id)?.status === "merging");
          const mid = [(a.x + b.x) / 2 + (conflict ? Math.sin(now / 18) * 5 : 0), (a.y + b.y) / 2 + (conflict ? Math.cos(now / 23) * 5 : 0)];
          const lit = hoveredRef.current === e.a || hoveredRef.current === e.b || selectedRef.current === e.a || selectedRef.current === e.b;
          form.strokeOnly(conflict ? danger() : strength > 0.6 ? warn() : ink(lit ? 0.7 : 0.35), 0.6 + strength * 2.4);
          form.line(Group.fromArray([[a.x, a.y], mid, [b.x, b.y]]));
        }
        // gate and nodes
        drawGate(g, now, s);
        const order = [...s.tasks].sort((x, y) => (isLive(x.status) ? 1 : 0) - (isLive(y.status) ? 1 : 0));
        for (const t of order) {
          const n = nodes.current.get(t.id);
          if (n) drawNodeShape(n, t, now, g);
        }
      },
    });

    // pointer: hover, click, pan; wheel: zoom
    const hit = (x: number, y: number): string | null => {
      const s = stateRef.current;
      if (!s) return null;
      let best: { id: string; d: number } | null = null;
      for (const t of s.tasks) {
        const n = nodes.current.get(t.id);
        if (!n) continue;
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < n.r + 8 && (!best || d < best.d)) best = { id: t.id, d };
      }
      if (best) return best.id;
      for (const f of screenFiles) {
        const d = Math.hypot(f.x - x, f.y - y);
        if (d < 9 && (!best || d < best.d)) best = { id: f.id, d };
      }
      return best?.id ?? null;
    };
    const local = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (dragging) {
        const dx = p.x - dragging.x;
        const dy = p.y - dragging.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) dragging.moved = true;
        if (dragging.moved) {
          const g = geometry();
          view.current.x = dragging.vx - dx / (g.scale * view.current.zoom);
          view.current.y = dragging.vy - dy / (g.scale * view.current.zoom);
        }
        return;
      }
      const id = hit(p.x, p.y);
      canvas.style.cursor = id ? "pointer" : "grab";
      handlers.current.onHover(id);
    };
    const onDown = (e: PointerEvent) => {
      const p = local(e);
      dragging = { x: p.x, y: p.y, moved: false, vx: view.current.x, vy: view.current.y };
      canvas.setPointerCapture(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      const p = local(e);
      const wasDrag = dragging?.moved;
      dragging = null;
      canvas.releasePointerCapture(e.pointerId);
      if (!wasDrag) handlers.current.onSelect(hit(p.x, p.y));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const g = geometry();
      const v = view.current;
      const before = { x: (p.x - g.cx) / (g.scale * v.zoom) + v.x, y: (p.y - g.cy) / (g.scale * v.zoom) + v.y };
      v.zoom = Num.clamp(v.zoom * Math.exp(-e.deltaY * 0.0012), 0.4, 4);
      v.x = before.x - (p.x - g.cx) / (g.scale * v.zoom);
      v.y = before.y - (p.y - g.cy) / (g.scale * v.zoom);
    };
    const onLeave = () => handlers.current.onHover(null);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    space.play();
    return () => {
      space.stop();
      space.removeAll();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  return <canvas ref={canvasRef} className="chart-canvas" aria-label="The repository map: files, agents and the merge gate" />;
}
