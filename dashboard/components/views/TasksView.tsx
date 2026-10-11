"use client";

import { StatusIcon } from "@/components/StatusIcon";
import { Badge } from "@/components/ui/badge";
import { elapsed, navigate, STATUS_LABEL, type TaskView } from "@/lib/api";

export function TasksView({ tasks, now }: { tasks: TaskView[]; now: number }) {
  const rows = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight mb-4">My work</h1>
        <div className="rounded-xl border bg-card divide-y">
          {rows.map((t) => (
            <button key={t.id} type="button" onClick={() => navigate(`/task/${t.id}`)} className="w-full grid grid-cols-[20px_1fr_auto_auto_auto] items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/40">
              <StatusIcon status={t.status} />
              <div className="min-w-0">
                <div className="text-sm truncate">{t.goal}</div>
                <div className="text-xs text-muted-foreground mono truncate">{t.id} · {t.files.length ? t.files.join(", ") : "no files yet"}</div>
              </div>
              <Badge variant="outline" className="text-[11px]">{STATUS_LABEL[t.status]}</Badge>
              <span className="mono text-xs text-muted-foreground">{t.costUsd == null ? "—" : `$${t.costUsd.toFixed(2)}`}</span>
              <span className="text-xs text-muted-foreground w-16 text-right">{elapsed(t.updatedAt, now)}</span>
            </button>
          ))}
          {rows.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">No tasks yet.</p>}
        </div>
      </div>
    </div>
  );
}
