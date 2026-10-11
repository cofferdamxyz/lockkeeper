"use client";

import { StatusIcon } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { elapsed, isLive, navigate, STATUS_LABEL, type TaskView } from "@/lib/api";

const ATTENTION = new Set(["needs_review", "blocked", "failed"]);

export function Radar({ tasks, projectId, now, limit = 8 }: { tasks: TaskView[]; projectId: string; now: number; limit?: number }) {
  const rank = (t: TaskView) => (ATTENTION.has(t.status) ? 0 : isLive(t.status) ? 1 : 2);
  const rows = [...tasks].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  const attention = tasks.filter((t) => ATTENTION.has(t.status)).length;
  const live = tasks.filter((t) => isLive(t.status)).length;
  // The heading says what the list is for right now; "all clear" is a state, not an absence.
  const title = attention > 0 ? "Needs you" : live > 0 ? "In flight" : "Recent";
  return (
    <section className="w-full">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold tracking-tight">
          {title}
          {attention === 0 && tasks.length > 0 && <span className="ml-3 text-xs font-normal text-muted-foreground">Nothing needs you</span>}
        </h2>
        <Button variant="link" size="sm" className="text-muted-foreground" onClick={() => navigate("/tasks")}>
          View all
        </Button>
      </div>
      <div className="rounded-xl border bg-card divide-y">
        {rows.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">Nothing yet. Describe a change above to launch the first agent.</p>}
        {rows.map((t) => (
          <button key={t.id} type="button" onClick={() => navigate(`/task/${t.id}`)} className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-accent/40">
            <StatusIcon status={t.status} className="size-4 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">
                {t.goal} <span className="mono text-xs text-muted-foreground">#{t.id.slice(-4)}</span>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {projectId} · {STATUS_LABEL[t.status].toLowerCase()}
                {t.hold ? " · review mode" : ""}
                {t.resolved ? " · conflict resolved" : ""} · {elapsed(t.updatedAt, now)} ago
              </div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
