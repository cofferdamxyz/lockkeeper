"use client";

import { ArrowLeft } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { ActivityStream } from "@/components/ActivityStream";
import { StatusIcon } from "@/components/StatusIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type ActivityEvent, api, elapsed, HOLDABLE, navigate, short, type StateView, STATUS_LABEL, type TaskAction, type TaskView as TaskRow } from "@/lib/api";
import { pickWindow } from "@/lib/city";
import { recoverChunk } from "@/lib/lazy";

const City = dynamic(recoverChunk(() => import("@/components/City")), { ssr: false });

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

function Fact({ label, children, tone }: { label: string; children: React.ReactNode; tone?: "good" | "bad" | "muted" }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className={`text-sm mt-0.5 whitespace-nowrap ${tone === "good" ? "text-foreground" : tone === "bad" ? "text-red-400" : tone === "muted" ? "text-muted-foreground" : ""}`}>{children}</div>
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
  onAction: (task: TaskRow, action: TaskAction) => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [brief, setBrief] = useState<string | null>(null);
  const [tab, setTab] = useState("activity");
  // The full row carries the brief and the diff; the state poll carries neither.
  useEffect(() => {
    let gone = false;
    api<{ diff: string | null; brief: string | null }>(`/api/tasks/${task.id}`)
      .then((t) => {
        if (gone) return;
        setDiff(t.diff ?? "");
        setBrief(t.brief ?? "");
      })
      .catch(() => {
        if (!gone) setDiff("");
      });
    return () => {
      gone = true;
    };
  }, [task.id, task.status]);
  const decision = state?.decisions.find((d) => d.candidates.includes(task.id));
  const merges = (state?.merges ?? []).filter((m) => m.task_id === task.id);
  const live = task.status === "running" || task.status === "merging";
  const duration = elapsed(task.createdAt, live ? now : new Date(task.updatedAt).getTime());
  const score = decision?.unattended[task.id];
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="h-full flex flex-col gap-0">
      <header className="border-b px-6 pt-4">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" className="size-8 -ml-2 shrink-0" aria-label="Back" onClick={() => navigate("/")}>
            <ArrowLeft className="size-4" />
          </Button>
          <StatusIcon status={task.status} className="size-4 mt-2" />
          <h1 className="text-[15px] font-medium leading-snug flex-1 min-w-0 line-clamp-2 pt-1">{task.goal}</h1>
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            <Badge variant="outline">{STATUS_LABEL[task.status]}</Badge>
            {task.status === "needs_review" && (
              <Button size="sm" disabled={busy} onClick={() => onAction(task, "approve")}>
                Approve merge
              </Button>
            )}
            {HOLDABLE.includes(task.status) && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction(task, task.hold ? "release" : "hold")}>
                {task.hold ? "Release hold" : "Hold for review"}
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
          </div>
        </div>
        <div className="mt-3 ml-9 grid grid-cols-[repeat(auto-fit,minmax(110px,max-content))] gap-x-8 gap-y-2">
          <Fact label="Task"><span className="mono">{task.id.slice(-4)}</span></Fact>
          <Fact label="Base → head"><span className="mono">{short(task.baseSha)} → {short(task.headSha)}</span></Fact>
          <Fact label="Tests" tone={task.testsOk === null ? "muted" : task.testsOk ? "good" : "bad"}>{task.testsOk === null ? "not run yet" : task.testsOk ? "green" : "red"}</Fact>
          <Fact label="Cost" tone={task.costUsd == null ? "muted" : undefined}><span className="mono">{task.costUsd == null ? "—" : `$${task.costUsd.toFixed(3)}`}</span></Fact>
          <Fact label={live ? "Running for" : "Took"}><span className="mono">{duration}</span></Fact>
          <Fact label="Commits"><span className="mono">{task.commits.length || "—"}</span></Fact>
          {task.hold && <Fact label="Merge">only with your approval</Fact>}
          {task.resolved && <Fact label="Conflict">resolved by the resolver agent</Fact>}
        </div>
        {task.files.length > 0 && (
          <div className="mt-2.5 ml-9 flex flex-wrap gap-1">
            {task.files.map((f) => (
              <span key={f} className="mono text-[11px] rounded-md border px-1.5 py-0.5 text-muted-foreground">{f}</span>
            ))}
          </div>
        )}
        {/* The record's sections as tabs on the header's bottom edge, the way a pull request page does it. */}
        <TabsList variant="line" className="mt-3 ml-7 h-9 gap-5">
          <TabsTrigger value="activity" className="px-1">Activity</TabsTrigger>
          <TabsTrigger value="map" className="px-1">Map</TabsTrigger>
          <TabsTrigger value="diff" className="px-1">
            Diff{task.files.length > 0 && <span className="mono text-[11px] text-muted-foreground">{task.files.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="decision" className="px-1">
            Decision{score != null && Number.isFinite(score) && <span className="mono text-[11px] text-muted-foreground">{score.toFixed(2)}</span>}
          </TabsTrigger>
        </TabsList>
      </header>
      <TabsContent value="activity" className="flex-1 min-h-0 overflow-auto px-6 py-5">
        <div className="max-w-2xl">
          <ActivityStream task={task} events={activity} brief={brief} live={live} />
          {task.error && <p className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-xs whitespace-pre-wrap">{task.error}</p>}
        </div>
      </TabsContent>
      <TabsContent value="map" className="flex-1 min-h-0 relative">
        {state && <City state={state} activity={{ [task.id]: activity }} now={now} at={null} windowMs={pickWindow(state, now)} selected={task.id} hovered={null} onSelect={() => undefined} onHover={() => undefined} dark={dark} focus={task.id} />}
      </TabsContent>
      <TabsContent value="diff" className="flex-1 min-h-0 overflow-auto px-6 py-4">
        {diff === null ? <p className="text-xs text-muted-foreground">Loading…</p> : diff === "" ? <p className="text-xs text-muted-foreground">No diff yet.</p> : (
          <pre className="mono text-[11px] leading-relaxed whitespace-pre-wrap break-words max-w-4xl">
            {diff.split("\n").map((l, i) => (
              <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "text-emerald-500" : l.startsWith("-") && !l.startsWith("---") ? "text-red-400" : l.startsWith("@@") ? "text-blue-400" : "text-muted-foreground"}>
                {l}
                {"\n"}
              </span>
            ))}
          </pre>
        )}
      </TabsContent>
      <TabsContent value="decision" className="flex-1 min-h-0 overflow-auto px-6 py-4 space-y-4 max-w-2xl">
              {decision ? (
                <>
                  <div className="eyebrow">Clef · {new Date(decision.at).toLocaleTimeString()} · {decision.candidates.length} candidate{decision.candidates.length === 1 ? "" : "s"}{decision.chosen === task.id ? " · chosen next" : ""}</div>
                  {decision.next[task.id] !== undefined && <Gauge label="next" value={decision.next[task.id]} />}
                  <Gauge label="unattended" value={decision.unattended[task.id]} threshold={task.resolved ? state?.config.clef.unattendedAfterResolve : state?.config.clef.unattended} />
                  <Gauge label="risk" value={decision.risk[task.id]} max={3} threshold={state?.config.clef.maxRisk} tone="amber" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {task.hold ? "Held: it waits for you regardless of the answers." : `Merges unattended when the yes probability clears the mark and risk stays under ${state?.config.clef.maxRisk}; otherwise it waits for you at the lock.`}
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
  );
}
