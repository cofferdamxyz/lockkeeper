"use client";

import { AnimatePresence, motion } from "motion/react";

import { Badge } from "@/components/ui/badge";
import { type ActivityEvent, elapsed, isLive, STATUS_LABEL, type TaskView } from "@/lib/api";

const TONE: Record<string, string> = {
  running: "border-blue-500/60 text-blue-500",
  ready: "border-foreground/50",
  merging: "border-blue-500 text-blue-500",
  approved: "border-blue-500/60",
  needs_review: "border-amber-400/70 text-amber-500",
  blocked: "border-red-400/60 text-red-400",
  queued: "border-border text-muted-foreground",
};

export function FleetStrip({
  tasks,
  activity,
  selected,
  onSelect,
  now,
}: {
  tasks: TaskView[];
  activity: Record<string, ActivityEvent[]>;
  selected: string | null;
  onSelect: (id: string) => void;
  now: number;
}) {
  const live = tasks.filter((t) => isLive(t.status));
  if (live.length === 0) return null;
  return (
    <div className="glass rounded-xl p-2 flex flex-col gap-1 max-h-[38vh] overflow-auto">
      <div className="eyebrow px-2 pt-1 pb-1">Fleet · {live.length}</div>
      <AnimatePresence initial={false}>
        {live.map((t) => {
          const acts = activity[t.id] ?? [];
          const last = [...acts].reverse().find((a) => a.kind === "tool" || a.kind === "note" || a.kind === "done");
          const latest = last ? (last.kind === "tool" ? last.summary : last.text) : t.status === "queued" ? "waiting for a sandbox" : "";
          const tools = acts.filter((a) => a.kind === "tool").length;
          return (
            <motion.button
              key={t.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
              onClick={() => onSelect(t.id)}
              className={`text-left rounded-lg px-2 py-1.5 hover:bg-accent/60 ${selected === t.id ? "bg-accent" : ""}`}
            >
              <div className="flex items-center gap-2">
                <span className="mono text-[11px] text-muted-foreground">{t.id.slice(-4)}</span>
                <Badge variant="outline" className={`h-5 px-1.5 text-[10px] ${TONE[t.status] ?? ""}`}>
                  {STATUS_LABEL[t.status]}
                </Badge>
                <span className="mono text-[11px] text-muted-foreground ml-auto">{elapsed(t.createdAt, now)}</span>
                {tools > 0 && <span className="mono text-[11px] text-muted-foreground">{tools} ops</span>}
                {t.costUsd != null && <span className="mono text-[11px] text-muted-foreground">${t.costUsd.toFixed(2)}</span>}
              </div>
              <div className="text-xs truncate max-w-[340px]">{t.goal}</div>
              {latest && <div className="text-[11px] text-muted-foreground truncate max-w-[340px]">{latest}</div>}
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
