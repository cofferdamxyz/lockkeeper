"use client";

import dynamic from "next/dynamic";

import { FleetStrip } from "@/components/FleetStrip";
import { Timeline } from "@/components/Timeline";
import { Button } from "@/components/ui/button";
import { type ActivityEvent, type HistoryItem, navigate, short, type StateView, STATUS_LABEL } from "@/lib/api";

const Chart = dynamic(() => import("@/components/Chart"), { ssr: false });

export function MapView({
  state,
  shown,
  history,
  activity,
  selected,
  hovered,
  onSelect,
  onHover,
  replayAt,
  onScrub,
  timeStart,
  now,
  dark,
}: {
  state: StateView | null;
  shown: StateView | null;
  history: HistoryItem[];
  activity: Record<string, ActivityEvent[]>;
  selected: string | null;
  hovered: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  replayAt: number | null;
  onScrub: (at: number | null) => void;
  timeStart: number;
  now: number;
  dark: boolean;
}) {
  const sel = shown?.tasks.find((t) => t.id === selected) ?? null;
  const hov = shown?.tasks.find((t) => t.id === hovered) ?? null;
  const pos = shown?.positions.find((p) => p.id === (hovered ?? selected)) ?? null;
  return (
    <div className="relative h-full">
      <div className="absolute inset-0">{shown ? <Chart state={shown} selected={selected} hovered={hovered} onSelect={onSelect} onHover={onHover} activity={activity} birthAt={null} dark={dark} /> : null}</div>
      <div className="absolute top-3 left-3 flex items-center gap-2">
        <div className="glass rounded-lg px-3 py-1.5 mono text-[11px] text-muted-foreground flex items-center gap-4">
          <span>main <span className="text-foreground">{short(shown?.project?.head)}</span></span>
          <span>{shown?.positions.filter((p) => p.kind === "file").length ?? 0} files</span>
          <span>{shown?.positions.filter((p) => p.kind === "commit").length ?? 0} commits</span>
          <span>{shown?.tasks.filter((t) => ["running", "queued", "ready", "merging", "approved", "needs_review"].includes(t.status)).length ?? 0} in flight</span>
          {state && !state.index && <span className="text-amber-500">index off</span>}
          {replayAt !== null && <span className="text-blue-500">replay</span>}
        </div>
      </div>
      {(sel || hov || (pos && pos.kind !== "task")) && (
        <div className="absolute top-14 left-3 glass rounded-lg px-3 py-2 text-xs max-w-[420px]">
          {(sel ?? hov) && (
            <>
              <div className="mono text-muted-foreground">{(sel ?? hov)!.id} · {STATUS_LABEL[(sel ?? hov)!.status]}</div>
              <div className="text-foreground">{(sel ?? hov)!.goal}</div>
              {sel && (
                <Button variant="link" size="sm" className="px-0 h-6" onClick={() => navigate(`/task/${sel.id}`)}>
                  Open session →
                </Button>
              )}
            </>
          )}
          {!sel && !hov && pos && pos.kind === "file" && (
            <>
              <div className="mono">{pos.label}</div>
              <div className="text-muted-foreground">{shown?.tasks.filter((t) => t.files.includes(pos.label)).map((t) => t.id.slice(-4)).join(", ") || "no agent touched this file"}</div>
            </>
          )}
          {!sel && !hov && pos && pos.kind === "commit" && (
            <>
              <div className="mono text-muted-foreground">commit {short(pos.meta?.sha)}{pos.meta?.author ? ` · ${pos.meta.author}` : ""}</div>
              <div>{pos.label}</div>
            </>
          )}
        </div>
      )}
      <div className="absolute left-3 bottom-16 w-[380px] max-w-[calc(100%-24px)]">
        {shown && <FleetStrip tasks={shown.tasks} activity={activity} selected={selected} onSelect={(id) => onSelect(id)} now={replayAt ?? now} />}
      </div>
      <div className="absolute left-3 right-3 bottom-3">
        <Timeline history={history} start={timeStart} end={now} at={replayAt} onScrub={onScrub} />
      </div>
    </div>
  );
}
