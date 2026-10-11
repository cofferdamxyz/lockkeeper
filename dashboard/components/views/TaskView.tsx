"use client";

import { ArrowLeft } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { ActivityStream } from "@/components/ActivityStream";
import { StatusIcon } from "@/components/StatusIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type ActivityEvent, api, elapsed, navigate, short, type StateView, STATUS_LABEL, type TaskView as TaskRow } from "@/lib/api";

const Chart = dynamic(() => import("@/components/Chart"), { ssr: false });

function Gauge({ label, value, threshold, max = 1, tone = "blue" }: { label: string; value: number | null | undefined; threshold?: number; max?: number; tone?: "blue" | "amber" }) {
  const v = value == null || Number.isNaN(value) ? null : value;
  const pct = v == null ? 0 : Math.min(100, (v / max) * 100);
  return (
    <div className="grid grid-cols-[88px_1fr_60px] items-center gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="relative h-1.5 rounded-full bg-muted">
        <span className={`absolute left-0 top-0 h-full rounded-full ${tone === "amber" ? "bg-amber-400" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
        {threshold !== undefined && <span className="absolute -top-1 h-3.5 w-px bg-foreground/80" style={{ left: `${(threshold / max) * 100}%` }} />}
      </span>
      <span className="mono text-right">{v == null ? "n/a" : v.toFixed(2)}{max !== 1 ? ` / ${max}` : ""}</span>
    </div>
  );
}

export function TaskView({
  task,
  state,
  activity,
  now,
  busy,
  dark,
  onAction,
}: {
  task: TaskRow;
  state: StateView | null;
  activity: ActivityEvent[];
  now: number;
  busy: boolean;
  dark: boolean;
  onAction: (task: TaskRow, action: "approve" | "retry" | "abandon") => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [tab, setTab] = useState("map");
  useEffect(() => {
    setDiff(null);
  }, [task.id]);
  useEffect(() => {
    if (tab !== "diff" || diff !== null) return;
    void api<{ diff: string | null }>(`/api/tasks/${task.id}`).then((t) => setDiff(t.diff ?? "")).catch(() => setDiff(""));
  }, [tab, task.id, diff]);
  const decision = state?.decisions.find((d) => d.candidates.includes(task.id));
  const merges = (state?.merges ?? []).filter((m) => m.task_id === task.id);
  const live = task.status === "running" || task.status === "merging";
  return (
    <div className="h-full flex flex-col">
      <header className="border-b px-6 py-3 flex items-center gap-3">
        <Button variant="ghost" size="icon" className="size-8" aria-label="Back" onClick={() => navigate("/")}>
          <ArrowLeft className="size-4" />
        </Button>
        <StatusIcon status={task.status} />
        <h1 className="text-sm font-medium truncate flex-1">{task.goal}</h1>
        <Badge variant="outline">{STATUS_LABEL[task.status]}</Badge>
        {task.hold && <Badge variant="secondary">review mode</Badge>}
        {task.resolved && <Badge variant="secondary">conflict resolved by agent</Badge>}
        {task.status === "needs_review" && (
          <Button size="sm" disabled={busy} onClick={() => onAction(task, "approve")}>
            Approve merge
          </Button>
        )}
        {["failed", "blocked", "needs_review", "abandoned"].includes(task.status) && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction(task, "retry")}>
            Retry from main
          </Button>
        )}
        {!["merged", "abandoned"].includes(task.status) && (
          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => onAction(task, "abandon")}>
            Abandon
          </Button>
        )}
      </header>
      <div className="mono text-[11px] text-muted-foreground px-6 py-2 border-b flex flex-wrap gap-x-5 gap-y-1">
        <span>{task.id}</span>
        <span>base {short(task.baseSha)}</span>
        <span>head {short(task.headSha)}</span>
        <span>tests {task.testsOk === null ? "—" : task.testsOk ? "green" : "red"}</span>
        <span>{task.costUsd == null ? "cost —" : `$${task.costUsd.toFixed(3)}`}</span>
        <span>{elapsed(task.createdAt, live ? now : new Date(task.updatedAt).getTime())}</span>
        {task.files.length > 0 && <span className="truncate">{task.files.join(" · ")}</span>}
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_460px]">
        <div className="min-h-0 overflow-auto px-6 py-5">
          <div className="max-w-2xl">
            <ActivityStream task={task} events={activity} live={live} />
            {task.error && <p className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-xs whitespace-pre-wrap">{task.error}</p>}
          </div>
        </div>
        <div className="min-h-0 border-l flex flex-col">
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="flex-1 min-h-0 flex flex-col">
            <TabsList className="m-3 self-start">
              <TabsTrigger value="map">Map</TabsTrigger>
              <TabsTrigger value="diff">Diff</TabsTrigger>
              <TabsTrigger value="decision">Decision</TabsTrigger>
            </TabsList>
            <TabsContent value="map" className="flex-1 min-h-0 relative">
              {state && <Chart state={state} selected={task.id} hovered={null} onSelect={() => undefined} onHover={() => undefined} activity={{ [task.id]: activity }} birthAt={null} dark={dark} focus={task.id} compact />}
            </TabsContent>
            <TabsContent value="diff" className="flex-1 min-h-0 overflow-auto px-4 pb-4">
              {diff === null ? <p className="text-xs text-muted-foreground">Loading…</p> : diff === "" ? <p className="text-xs text-muted-foreground">No diff yet.</p> : (
                <pre className="mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                  {diff.split("\n").map((l, i) => (
                    <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "text-emerald-500" : l.startsWith("-") && !l.startsWith("---") ? "text-red-400" : l.startsWith("@@") ? "text-blue-400" : "text-muted-foreground"}>
                      {l}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              )}
            </TabsContent>
            <TabsContent value="decision" className="flex-1 min-h-0 overflow-auto px-4 pb-4 space-y-4">
              {decision ? (
                <>
                  <div className="eyebrow">Clef · {new Date(decision.at).toLocaleTimeString()} · {decision.candidates.length} candidate{decision.candidates.length === 1 ? "" : "s"}{decision.chosen === task.id ? " · chosen next" : ""}</div>
                  {decision.next[task.id] !== undefined && <Gauge label="next" value={decision.next[task.id]} />}
                  <Gauge label="unattended" value={decision.unattended[task.id]} threshold={task.resolved ? state?.config.clef.unattendedAfterResolve : state?.config.clef.unattended} />
                  <Gauge label="risk" value={decision.risk[task.id]} max={3} threshold={state?.config.clef.maxRisk} tone="amber" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {task.hold ? "Launched in review mode: it waits for you regardless of the answers." : `Merges unattended when the yes probability clears the mark and risk stays under ${state?.config.clef.maxRisk}; otherwise it waits for you at the gate.`}
                  </p>
                  {decision.error && <p className="text-xs text-red-400">{decision.error}</p>}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">No merge round has weighed this change yet.</p>
              )}
              {merges.length > 0 && (
                <div className="space-y-1">
                  <div className="eyebrow">Lock</div>
                  {merges.map((m) => (
                    <div key={m.id} className="mono text-[11px] text-muted-foreground flex gap-3">
                      <span>{new Date(m.at).toLocaleTimeString()}</span>
                      <span className="text-foreground">{m.mode.replace("_", " ")}</span>
                      {m.conflict ? <span className="text-red-400">conflict{m.resolved_by ? ` · resolved by ${m.resolved_by}` : ""}</span> : null}
                      {m.main_after && <span>→ {short(m.main_after)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
