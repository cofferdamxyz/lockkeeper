"use client";

import { AlertTriangle, CheckCircle2, FileText, GitMerge, MessageSquare, Pencil, Terminal, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type ActivityEvent, api, type DecisionView, elapsed, short, STATUS_LABEL, type StateView, type TaskView } from "@/lib/api";

function Gauge({ label, value, threshold, max = 1, tone = "blue" }: { label: string; value: number | null | undefined; threshold?: number; max?: number; tone?: "blue" | "amber" }) {
  const v = value == null || Number.isNaN(value) ? null : value;
  const pct = v == null ? 0 : Math.min(100, (v / max) * 100);
  return (
    <div className="grid grid-cols-[88px_1fr_56px] items-center gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="relative h-1.5 rounded-full bg-muted overflow-visible">
        <span className={`absolute left-0 top-0 h-full rounded-full ${tone === "amber" ? "bg-amber-400" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
        {threshold !== undefined && <span className="absolute -top-1 h-3.5 w-px bg-foreground/80" style={{ left: `${(threshold / max) * 100}%` }} />}
      </span>
      <span className="mono text-right">{v == null ? "n/a" : v.toFixed(2)}{max !== 1 ? ` / ${max}` : ""}</span>
    </div>
  );
}

function Icon({ e }: { e: ActivityEvent }) {
  const cls = "size-3.5 shrink-0 mt-0.5";
  if (e.kind === "tool") {
    if (e.name === "Bash") return <Terminal className={`${cls} text-blue-500`} />;
    if (e.name === "Edit" || e.name === "Write" || e.name === "MultiEdit") return <Pencil className={`${cls}`} />;
    return <FileText className={`${cls} text-muted-foreground`} />;
  }
  if (e.kind === "note") return <MessageSquare className={`${cls} text-muted-foreground`} />;
  if (e.kind === "result") return e.ok ? <CheckCircle2 className={`${cls} text-muted-foreground`} /> : <XCircle className={`${cls} text-red-400`} />;
  if (e.kind === "done") return e.ok ? <CheckCircle2 className={`${cls} text-emerald-500`} /> : <XCircle className={`${cls} text-red-400`} />;
  return <GitMerge className={cls} />;
}

export function TaskSheet({
  task,
  state,
  activity,
  onClose,
  onAction,
  busy,
  now,
}: {
  task: TaskView | null;
  state: StateView | null;
  activity: ActivityEvent[];
  onClose: () => void;
  onAction: (task: TaskView, action: "approve" | "retry" | "abandon") => void;
  busy: boolean;
  now: number;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");
  useEffect(() => {
    setDiff(null);
    setTab("overview");
  }, [task?.id]);
  useEffect(() => {
    if (tab !== "diff" || !task || diff !== null) return;
    void api<{ diff: string | null }>(`/api/tasks/${task.id}`).then((t) => setDiff(t.diff ?? "")).catch(() => setDiff(""));
  }, [tab, task, diff]);
  const decision: DecisionView | undefined = task ? state?.decisions.find((d) => d.candidates.includes(task.id)) : undefined;
  const merges = task ? (state?.merges ?? []).filter((m) => m.task_id === task.id) : [];
  const conflict = merges.find((m) => m.conflict);
  return (
    <Sheet open={task !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[440px] sm:max-w-[440px] p-0 gap-0">
        {task && (
          <>
            <SheetHeader className="px-5 pt-5 pb-3 border-b">
              <div className="flex items-center gap-2">
                <SheetTitle className="mono text-sm">{task.id}</SheetTitle>
                <Badge variant="outline">{STATUS_LABEL[task.status]}</Badge>
                {task.resolved && <Badge variant="secondary">conflict resolved by agent</Badge>}
                {task.restarts > 0 && <Badge variant="secondary">restarted</Badge>}
              </div>
              <SheetDescription className="text-foreground/90 text-sm leading-snug">{task.goal}</SheetDescription>
              <div className="mono text-[11px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 pt-1">
                <span>base {short(task.baseSha)}</span>
                <span>head {short(task.headSha)}</span>
                <span>tests {task.testsOk === null ? "—" : task.testsOk ? "green" : "red"}</span>
                <span>{task.costUsd == null ? "cost —" : `$${task.costUsd.toFixed(3)}`}</span>
                <span>{elapsed(task.createdAt, task.status === "running" ? now : new Date(task.updatedAt).getTime())}</span>
              </div>
            </SheetHeader>
            <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="flex-1 min-h-0 flex flex-col">
              <TabsList className="mx-5 mt-3">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="activity">Activity{activity.length ? ` · ${activity.filter((a) => a.kind === "tool").length}` : ""}</TabsTrigger>
                <TabsTrigger value="diff">Diff</TabsTrigger>
                <TabsTrigger value="decision">Decision</TabsTrigger>
              </TabsList>
              <ScrollArea className="flex-1 min-h-0">
                <TabsContent value="overview" className="px-5 py-4 space-y-4">
                  {task.files.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {task.files.map((f) => (
                        <code key={f} className="mono text-[11px] rounded-md border px-1.5 py-0.5 bg-muted/40">{f}</code>
                      ))}
                    </div>
                  )}
                  {task.diffstat && <pre className="mono text-[11px] text-muted-foreground rounded-lg bg-muted/40 p-3 whitespace-pre-wrap">{task.diffstat.trim()}</pre>}
                  {task.error && (
                    <div className="flex gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-xs">
                      <AlertTriangle className="size-4 shrink-0 text-amber-500" />
                      <span className="whitespace-pre-wrap">{task.error}</span>
                    </div>
                  )}
                  {task.summary && <p className="text-sm whitespace-pre-wrap leading-relaxed">{task.summary}</p>}
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
                <TabsContent value="activity" className="px-5 py-4">
                  {activity.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{task.status === "queued" ? "Waiting for a sandbox." : "No activity recorded."}</p>
                  ) : (
                    <ol className="space-y-2">
                      {activity.map((e, i) => (
                        <li key={i} className="flex gap-2 text-xs">
                          <Icon e={e} />
                          <span className={`min-w-0 break-words ${e.kind === "result" ? "text-muted-foreground mono text-[11px]" : e.kind === "done" ? "whitespace-pre-wrap" : ""}`}>
                            {e.kind === "start" && `started${e.model ? ` · ${e.model}` : ""}`}
                            {e.kind === "tool" && <span className="mono">{e.summary}</span>}
                            {e.kind === "note" && e.text}
                            {e.kind === "result" && e.text}
                            {e.kind === "done" && `${e.text}${e.costUsd != null ? `\n\n$${e.costUsd.toFixed(3)} · ${e.turns ?? "?"} turns` : ""}`}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </TabsContent>
                <TabsContent value="diff" className="px-5 py-4">
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
                <TabsContent value="decision" className="px-5 py-4 space-y-4">
                  {decision ? (
                    <>
                      <div className="eyebrow">Clef · {new Date(decision.at).toLocaleTimeString()} · {decision.candidates.length} candidate{decision.candidates.length === 1 ? "" : "s"}{decision.chosen === task.id ? " · chosen next" : ""}</div>
                      {decision.next[task.id] !== undefined && <Gauge label="next" value={decision.next[task.id]} />}
                      <Gauge label="unattended" value={decision.unattended[task.id]} threshold={task.resolved ? state?.config.clef.unattendedAfterResolve : state?.config.clef.unattended} />
                      <Gauge label="risk" value={decision.risk[task.id]} max={3} threshold={state?.config.clef.maxRisk} tone="amber" />
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Merges unattended when the yes probability clears the mark and risk stays under {state?.config.clef.maxRisk}; otherwise it waits for you at the gate.
                      </p>
                      {decision.error && <p className="text-xs text-red-400">{decision.error}</p>}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">No merge round has weighed this change yet.</p>
                  )}
                  {conflict && (
                    <p className="text-xs text-muted-foreground">A conflict was {conflict.resolved_by ? `resolved by the ${conflict.resolved_by}` : "handed to the resolver"} before this decision.</p>
                  )}
                </TabsContent>
              </ScrollArea>
            </Tabs>
            <div className="flex gap-2 px-5 py-4 border-t">
              {task.status === "needs_review" && (
                <Button disabled={busy} onClick={() => onAction(task, "approve")}>
                  Approve merge
                </Button>
              )}
              {["failed", "blocked", "needs_review", "abandoned"].includes(task.status) && (
                <Button variant="outline" disabled={busy} onClick={() => onAction(task, "retry")}>
                  Retry from main
                </Button>
              )}
              {!["merged", "abandoned"].includes(task.status) && (
                <Button variant="ghost" disabled={busy} onClick={() => onAction(task, "abandon")} className="ml-auto text-muted-foreground">
                  Abandon
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
