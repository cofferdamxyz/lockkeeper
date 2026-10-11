"use client";

import { Lock, Map as MapIcon } from "lucide-react";

import { navigate, type TaskView } from "@/lib/api";

const WORKING = new Set(["queued", "running", "ready", "merging", "approved"]);
const NEEDS_YOU = new Set(["needs_review", "blocked", "failed"]);
const DAY = 24 * 60 * 60_000;

/** One line that says what the fleet is doing: working, waiting for you, landed today. */
export function FleetSummary({ tasks, now }: { tasks: TaskView[]; now: number }) {
  const working = tasks.filter((t) => WORKING.has(t.status)).length;
  const needsYou = tasks.filter((t) => NEEDS_YOU.has(t.status)).length;
  const landed = tasks.filter((t) => t.status === "merged" && now - new Date(t.updatedAt).getTime() < DAY).length;
  const quiet = working === 0 && needsYou === 0;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
      {quiet ? (
        <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-muted-foreground">
          <span className="size-2 rounded-full bg-foreground/40" /> All quiet
        </span>
      ) : (
        <button type="button" onClick={() => navigate("/map")} className="inline-flex items-center gap-2 rounded-full border px-3 py-1 hover:bg-accent/50">
          <MapIcon className="size-3.5 text-blue-500" /> {working} working
        </button>
      )}
      {needsYou > 0 && (
        <button type="button" onClick={() => navigate("/tasks")} className="inline-flex items-center gap-2 rounded-full border border-amber-400/50 bg-amber-400/10 px-3 py-1 text-amber-600 dark:text-amber-400 hover:bg-amber-400/20">
          <Lock className="size-3.5" /> {needsYou} need{needsYou === 1 ? "s" : ""} you
        </button>
      )}
      <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-muted-foreground">{landed} merged today</span>
    </div>
  );
}
