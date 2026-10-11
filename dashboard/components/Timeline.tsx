"use client";

import type { HistoryItem } from "@/lib/api";

export function Timeline({
  history,
  start,
  end,
  at,
  onScrub,
}: {
  history: HistoryItem[];
  start: number;
  end: number;
  at: number | null;
  onScrub: (at: number | null) => void;
}) {
  const span = Math.max(1, end - start);
  const pos = (t: number) => `${Math.min(100, Math.max(0, ((t - start) / span) * 100))}%`;
  const live = at === null;
  const value = live ? end : at;
  return (
    <div className="glass rounded-xl px-3 py-2 flex items-center gap-3">
      <button
        type="button"
        onClick={() => onScrub(null)}
        className={`text-[11px] uppercase tracking-[0.16em] px-2 py-1 rounded-md ${live ? "text-blue-500" : "text-muted-foreground hover:text-foreground"}`}
      >
        {live ? "● live" : "replay"}
      </button>
      <div className="relative flex-1 h-6">
        <div className="absolute left-0 right-0 top-1/2 h-px bg-border" />
        {history.map((h, i) => {
          const t = new Date(h.at).getTime();
          // amber waits for a person, red failed, blue a person approved, white landed unattended
          const cls =
            h.kind === "merge"
              ? h.conflict
                ? "bg-red-400"
                : h.mode === "needs_review" || h.mode === "error"
                  ? "bg-amber-400"
                  : h.mode === "approved"
                    ? "bg-blue-500"
                    : "bg-foreground/85"
              : h.kind === "decision"
                ? "bg-foreground/50"
                : h.kind === "push"
                  ? "bg-foreground/30"
                  : "bg-foreground/15";
          const h2 = h.kind === "merge" ? "h-3" : h.kind === "decision" ? "h-2.5" : "h-1.5";
          return <span key={i} className={`absolute top-1/2 -translate-y-1/2 w-px ${h2} ${cls}`} style={{ left: pos(t) }} />;
        })}
        <input
          type="range"
          min={start}
          max={end}
          step={1000}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            onScrub(v >= end - 1500 ? null : v);
          }}
          className="absolute inset-0 w-full opacity-0 cursor-ew-resize"
          aria-label="Timeline"
        />
        <span className="absolute top-0 bottom-0 w-px bg-foreground pointer-events-none" style={{ left: pos(value) }} />
      </div>
      <span className="mono text-[11px] text-muted-foreground w-16 text-right">{new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
    </div>
  );
}
