"use client";

import { ArrowDown, ArrowUp, ExternalLink, FileCode2, GitCommitHorizontal, GitMerge, HelpCircle, Lock, Radio, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

import { Prose } from "@/components/Prose";
import { StatusIcon } from "@/components/StatusIcon";
import { Timeline } from "@/components/Timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type ActivityEvent, api, type CommitDetail, elapsed, type FileDetail, HOLDABLE, type HistoryItem, navigate, short, type StateView, STATUS_LABEL, type TaskAction, type TaskView } from "@/lib/api";
import { buildCity, type City as CityModel, type LockCandidate, timeAnchors, windowLabel } from "@/lib/city";
import { recoverChunk } from "@/lib/lazy";

const City = dynamic(recoverChunk(() => import("@/components/City")), { ssr: false, loading: () => <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Loading the scene…</div> });

export type WindowChoice = "auto" | number;
const WINDOW_CHOICES: { label: string; value: WindowChoice }[] = [
  { label: "auto", value: "auto" },
  { label: "1h", value: 60 * 60_000 },
  { label: "3h", value: 180 * 60_000 },
  { label: "12h", value: 720 * 60_000 },
  { label: "2d", value: 2880 * 60_000 },
];

function CommitPanel({ projectId, sha, onClose, onOpenFile }: { projectId: string; sha: string; onClose: () => void; onOpenFile: (path: string) => void }) {
  const [d, setD] = useState<CommitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    setErr(null);
    api<CommitDetail>(`/api/projects/${projectId}/commits/${sha}`).then(setD).catch((e) => setErr(String(e)));
  }, [projectId, sha]);
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start gap-2 px-4 pt-4 pb-3 border-b">
        <GitCommitHorizontal className="size-4 mt-0.5 text-blue-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-snug break-words">{d?.message ?? "Commit"}</div>
          <div className="mono text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-x-3">
            <span>{short(sha)}</span>
            {d?.author && <span>{d.author}</span>}
            {d?.at && <span>{new Date(d.at).toLocaleString()}</span>}
            {d?.merge && <span>merge</span>}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-3 space-y-4">
          {err && <p className="text-xs text-red-400">{err}</p>}
          {d?.task && (
            <Button variant="outline" size="sm" onClick={() => navigate(`/task/${d.task}`)}>
              <ExternalLink className="size-3.5" /> Open session {d.task.slice(-4)}
            </Button>
          )}
          {d && d.files.length > 0 && (
            <div>
              <div className="eyebrow mb-1.5">Files changed</div>
              <div className="flex flex-col gap-1">
                {d.files.map((f) => (
                  <button key={f} type="button" onClick={() => onOpenFile(f)} className="mono text-[11px] text-left rounded-md border px-2 py-1 hover:bg-accent/50 truncate">
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}
          {d?.body && d.body !== d.message && <pre className="mono text-[11px] text-muted-foreground whitespace-pre-wrap">{d.body}</pre>}
          {d && d.parents.length > 0 && <div className="mono text-[11px] text-muted-foreground">parents {d.parents.map((p) => short(p)).join(", ")}</div>}
        </div>
      </ScrollArea>
    </div>
  );
}

function FilePanel({ projectId, path, state, city, onClose, onOpenCommit }: { projectId: string; path: string; state: StateView | null; city: CityModel | null; onClose: () => void; onOpenCommit: (sha: string) => void }) {
  const [d, setD] = useState<FileDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = city?.byPath.get(path);
  useEffect(() => {
    setD(null);
    setErr(null);
    if (file?.ghost || file?.deleted) return;
    api<FileDetail>(`/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`).then(setD).catch((e) => setErr(String(e)));
  }, [projectId, path, file?.ghost, file?.deleted]);
  const touching = state?.tasks.filter((t) => t.files.includes(path) || city?.byTask.get(t.id)?.files.includes(path)) ?? [];
  const others = city?.overlaps.get(path) ?? [];
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start gap-2 px-4 pt-4 pb-3 border-b">
        <FileCode2 className="size-4 mt-0.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="mono text-sm font-medium break-all">{path}</div>
          <div className="mono text-[11px] text-muted-foreground mt-1">
            {file?.ghost ? "added by a fork in flight; not on main yet" : file?.deleted ? "removed from main" : d ? `${d.bytes} bytes${d.truncated ? " · truncated" : ""}` : ""}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-3 space-y-4">
          {err && <p className="text-xs text-red-400">{err}</p>}
          {others.length >= 2 && <p className="text-xs rounded-md border border-red-400/40 bg-red-400/10 px-2 py-1.5">Two agents are changing this file: {others.map((id) => id.slice(-4)).join(" and ")}. The lock will order them; hold one if you want to decide.</p>}
          {touching.length > 0 && (
            <div>
              <div className="eyebrow mb-1.5">Agents touching it</div>
              {touching.map((t) => (
                <button key={t.id} type="button" onClick={() => navigate(`/task/${t.id}`)} className="w-full flex items-center gap-2 text-left text-xs rounded-md px-2 py-1 hover:bg-accent/50">
                  <StatusIcon status={t.status} className="size-3.5" /> <span className="mono text-muted-foreground">{t.id.slice(-4)}</span> <span className="truncate">{t.goal}</span>
                </button>
              ))}
            </div>
          )}
          {d && d.commits.length > 0 && (
            <div>
              <div className="eyebrow mb-1.5">Commits</div>
              {d.commits.map((c) => (
                <button key={c.sha} type="button" onClick={() => onOpenCommit(c.sha)} className="w-full text-left text-xs rounded-md px-2 py-1 hover:bg-accent/50 flex gap-2">
                  <span className="mono text-blue-500 shrink-0">{short(c.sha)}</span>
                  <span className="truncate">{c.message}</span>
                </button>
              ))}
            </div>
          )}
          {d?.text != null ? (
            <pre className="mono text-[11px] leading-relaxed whitespace-pre rounded-lg bg-muted/40 p-3 overflow-x-auto">
              {d.text.split("\n").map((l, i) => (
                <span key={i} className="block">
                  <span className="inline-block w-8 text-right pr-3 text-muted-foreground/60 select-none">{i + 1}</span>
                  {l}
                </span>
              ))}
            </pre>
          ) : d ? (
            <p className="text-xs text-muted-foreground">Binary file.</p>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function Gauge({ label, value, threshold, max = 1, tone = "blue" }: { label: string; value: number | null | undefined; threshold?: number; max?: number; tone?: "blue" | "amber" }) {
  const v = value == null || Number.isNaN(value) ? null : value;
  const pct = v == null ? 0 : Math.min(100, (v / max) * 100);
  return (
    <div className="grid grid-cols-[80px_1fr_52px] items-center gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="relative h-1.5 rounded-full bg-muted">
        <span className={`absolute left-0 top-0 h-full rounded-full ${tone === "amber" ? "bg-amber-400" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
        {threshold !== undefined && <span className="absolute -top-1 h-3.5 w-px bg-foreground/80" style={{ left: `${(threshold / max) * 100}%` }} />}
      </span>
      <span className="mono text-right">{v == null ? "n/a" : v.toFixed(2)}</span>
    </div>
  );
}

/** A merge ring was picked: how it happened and what Clef saw. */
function MergePanel({ mergeId, state, city, onClose, onSelect }: { mergeId: number; state: StateView; city: CityModel; onClose: () => void; onSelect: (id: string) => void }) {
  const m = state.merges.find((x) => x.id === mergeId);
  const cm = city.merges.find((x) => x.id === mergeId);
  const task = m ? state.tasks.find((t) => t.id === m.task_id) : undefined;
  const decision = m?.decision_id ? state.decisions.find((d) => d.id === m.decision_id) : undefined;
  const projectId = state.project?.id ?? "sample-api";
  if (!m) return <p className="p-4 text-xs text-muted-foreground">That merge is not in the recent ledger.</p>;
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start gap-2 px-4 pt-4 pb-3 border-b">
        <GitMerge className="size-4 mt-0.5 text-blue-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-snug">{task?.goal ?? m.task_id}</div>
          <div className="mono text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-x-3">
            <span>{m.task_id.slice(-4)}</span>
            <span>{new Date(m.at).toLocaleTimeString()}</span>
            <span className="text-foreground">{cm?.kind ?? m.mode}</span>
            {m.main_after && <span>main {short(m.main_after)}</span>}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-3 space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {cm?.kind === "approved" ? "A person approved this merge from the dashboard." : cm?.kind === "resolved" ? "The merge conflicted with main; the resolver agent reconciled both changes and the tests passed before it landed." : "Clef cleared this change to merge without a person."}
          </p>
          {decision ? (
            <div className="space-y-2">
              <div className="eyebrow">Decision · {decision.candidates.length} candidate{decision.candidates.length === 1 ? "" : "s"}</div>
              <Gauge label="unattended" value={decision.unattended[m.task_id]} threshold={task?.resolved ? state.config.clef.unattendedAfterResolve : state.config.clef.unattended} />
              <Gauge label="risk" value={decision.risk[m.task_id]} max={3} threshold={state.config.clef.maxRisk} tone="amber" />
              {decision.candidates.length > 1 && (
                <div className="pt-1">
                  <div className="eyebrow mb-1">Weighed against</div>
                  {decision.candidates.filter((c) => c !== m.task_id).map((c) => (
                    <button key={c} type="button" onClick={() => onSelect(c)} className="w-full text-left text-xs rounded-md px-2 py-1 hover:bg-accent/50 flex gap-3">
                      <span className="mono text-muted-foreground">{c.slice(-4)}</span>
                      <span className="mono">next {(decision.next[c] ?? 0).toFixed(2)}</span>
                      <span className="mono">unattended {(decision.unattended[c] ?? 0)?.toFixed(2)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No Clef decision is attached to this merge.</p>
          )}
          {task && task.files.length > 0 && (
            <div>
              <div className="eyebrow mb-1.5">Landed on</div>
              <div className="flex flex-col gap-1">
                {task.files.map((f) => (
                  <button key={f} type="button" onClick={() => onSelect(`file:${projectId}:${f}`)} className="mono text-[11px] text-left rounded-md border px-2 py-1 hover:bg-accent/50 truncate">
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}
          {task && (
            <Button variant="outline" size="sm" onClick={() => navigate(`/task/${task.id}`)}>
              <ExternalLink className="size-3.5" /> Open session
            </Button>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** The lock as a list: the same candidates as the chamber on the column, same order. */
function LockPanel({ lock, selected, onSelect, onReorder }: { lock: LockCandidate[]; selected: string | null; onSelect: (id: string) => void; onReorder: (order: string[]) => void }) {
  const ids = lock.map((c) => c.task.id);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    onReorder(next);
  };
  const anyPinned = lock.some((c) => c.pinned);
  if (lock.length === 0) {
    return (
      <div className="glass rounded-full px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-1.5">
        <Lock className="size-3.5 text-blue-500" /> Lock · empty
      </div>
    );
  }
  return (
    <div className="glass rounded-xl p-2 w-[340px] max-w-[calc(100vw-24px)] max-h-[40vh] overflow-auto">
      <div className="flex items-center px-2 pt-1 pb-1.5">
        <Lock className="size-3.5 text-blue-500 mr-1.5" />
        <span className="eyebrow">Lock · {lock.length ? `${lock.length} waiting` : "empty"}</span>
        {anyPinned && (
          <Button variant="ghost" size="sm" className="ml-auto h-6 text-[11px] text-muted-foreground" onClick={() => onReorder([])}>
            let Clef decide
          </Button>
        )}
      </div>
      {lock.map((c, i) => (
        <div key={c.task.id} className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/60 ${selected === c.task.id ? "bg-accent" : ""}`}>
          <button type="button" onClick={() => onSelect(c.task.id)} className="flex-1 min-w-0 text-left">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full shrink-0" style={{ background: c.color }} />
              <span className="mono text-[11px] text-muted-foreground">{c.task.id.slice(-4)}</span>
              <span className="text-xs truncate">{c.task.goal}</span>
            </div>
            <div className="text-[11px] text-muted-foreground truncate pl-4">
              {c.reason}
              {c.risk !== null ? ` · risk ${c.risk.toFixed(2)}` : ""}
              {c.task.status === "needs_review" ? " · waits for you" : ""}
            </div>
          </button>
          {c.task.status !== "merging" && (
            <div className="flex flex-col opacity-0 group-hover:opacity-100">
              <button type="button" aria-label="Earlier" className="text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="size-3" />
              </button>
              <button type="button" aria-label="Later" className="text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === ids.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="size-3" />
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const LEGEND: [string, string][] = [
  ["block", "a file: height is size, brightness is recent change; translucent means added by a fork and not on main yet"],
  ["ring", "directory depth; a sector is a directory, files that change together sit side by side"],
  ["plate", "a commit over the files it touched; height is time, and a quiet stretch folds into a short break"],
  ["stack", "a branch: commits A, then B, then C; amber dashed waits for you, red failed or blocked"],
  ["column", "main; a ring on it is a merge: white landed unattended, blue a person approved, a double ring resolved a conflict first"],
  ["chamber", "the discs under the now ring are the changes waiting to enter main, in the order they will; drag to reorder"],
  ["beacon", "an agent over the file it is on now; a red halo marks two agents changing one file"],
  ["now ring", "drag it down the column to replay; the timeline below does the same"],
];

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
  windowChoice,
  windowMs,
  onWindow,
  onReorder,
  liveOpen,
  onAction,
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
  windowChoice: WindowChoice;
  windowMs: number;
  onWindow: (w: WindowChoice) => void;
  onReorder: (order: string[]) => void;
  liveOpen: boolean;
  onAction: (task: TaskView, action: TaskAction) => void;
}) {
  const projectId = state?.project?.id ?? "sample-api";
  // The clock ticks every second; the strata only need to move every few seconds.
  const cityNow = Math.floor(now / 5000) * 5000;
  // Folds come from the full history, so replay lowers the ring without reshaping the column.
  const anchors = useMemo(() => (state ? timeAnchors(state, cityNow) : []), [state, cityNow]);
  const city = useMemo(() => (shown ? buildCity(shown, { now: cityNow, windowMs, activity, at: replayAt, anchors }) : null), [shown, cityNow, windowMs, activity, replayAt, anchors]);
  const [legend, setLegend] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect]);
  const selTask = shown?.tasks.find((t) => t.id === selected) ?? null;
  const selPos = shown?.positions.find((p) => p.id === selected) ?? null;
  const selMerge = selected?.startsWith("merge:") ? Number(selected.slice(6)) : null;
  const hovTask = shown?.tasks.find((t) => t.id === hovered) ?? null;
  const open = selected !== null && selected !== "now";
  const panelWidth = open ? "right-[400px]" : "right-0";
  const liveCount = shown?.tasks.filter((t) => ["running", "queued", "ready", "merging", "approved", "needs_review"].includes(t.status)).length ?? 0;
  const landed = city?.merges.filter((m) => m.y > 0).length ?? 0;
  return (
    <div className="relative h-full">
      <div className={`absolute inset-y-0 left-0 ${panelWidth} transition-[right] duration-200`}>
        {shown && city ? <City state={shown} city={city} activity={activity} now={cityNow} at={replayAt} windowMs={windowMs} selected={selected} hovered={hovered} onSelect={onSelect} onHover={onHover} onScrub={onScrub} onReorder={onReorder} dark={dark} /> : null}
        <div className="absolute top-3 left-3 flex flex-col gap-2 items-start">
          <div className="glass rounded-lg px-3 py-1.5 mono text-[11px] text-muted-foreground flex items-center gap-4">
            <span>main <span className="text-foreground">{short(shown?.project?.head)}</span></span>
            <span>{city?.files.filter((f) => !f.ghost && !f.deleted).length ?? 0} files</span>
            <span>{liveCount} in flight</span>
            <span>{landed} merged in {windowLabel(windowMs)}</span>
            {state && !state.index && <span className="text-amber-500">index off</span>}
            {replayAt !== null && <span className="text-amber-400">replay</span>}
            <span className={`flex items-center gap-1 ${liveOpen ? "text-blue-500" : ""}`} title={liveOpen ? "live updates over WebSocket" : "polling"}>
              <Radio className="size-3" /> {liveOpen ? "live" : "poll"}
            </span>
          </div>
          <div className="glass rounded-lg px-2 py-1 flex items-center gap-1 text-[11px]">
            <span className="text-muted-foreground px-1">window</span>
            {WINDOW_CHOICES.map((w) => (
              <button key={w.label} type="button" onClick={() => onWindow(w.value)} className={`rounded-md px-1.5 py-0.5 mono ${windowChoice === w.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {w.label}
              </button>
            ))}
          </div>
          {hovTask && !open && (
            <div className="glass rounded-lg px-3 py-2 text-xs max-w-[420px] pointer-events-none">
              <div className="mono text-muted-foreground">{hovTask.id} · {STATUS_LABEL[hovTask.status]}</div>
              <div>{hovTask.goal}</div>
            </div>
          )}
        </div>
        <div className="absolute right-3 bottom-16 flex flex-col items-end">{city && <LockPanel lock={city.lock} selected={selected} onSelect={onSelect} onReorder={onReorder} />}</div>
        <div className="absolute left-3 bottom-16 flex flex-col items-start gap-2">
          {legend && (
            <div className="glass rounded-xl p-3 max-w-[560px] text-[11px] leading-relaxed">
              <div className="eyebrow mb-1.5">How to read</div>
              <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1">
                {LEGEND.map(([k, v]) => (
                  <div key={k} className="contents">
                    <span className="font-semibold text-foreground">{k}</span>
                    <span className="text-muted-foreground">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Button variant="ghost" size="sm" className="glass h-7 text-[11px] text-muted-foreground" onClick={() => setLegend((l) => !l)}>
            <HelpCircle className="size-3.5" /> {legend ? "Hide" : "How to read"}
          </Button>
        </div>
        <div className="absolute left-3 right-3 bottom-3">
          <Timeline history={history} start={timeStart} end={now} at={replayAt} onScrub={onScrub} />
        </div>
      </div>
      {open && (
        <aside className="absolute inset-y-0 right-0 w-[400px] border-l bg-background">
          {selPos?.kind === "commit" && selPos.meta?.sha && <CommitPanel projectId={projectId} sha={selPos.meta.sha} onClose={() => onSelect(null)} onOpenFile={(path) => onSelect(`file:${projectId}:${path}`)} />}
          {selected?.startsWith(`file:${projectId}:`) && <FilePanel projectId={projectId} path={selected.slice(`file:${projectId}:`.length)} state={state} city={city} onClose={() => onSelect(null)} onOpenCommit={(sha) => onSelect(`commit:${projectId}:${sha}`)} />}
          {selMerge !== null && shown && city && <MergePanel mergeId={selMerge} state={shown} city={city} onClose={() => onSelect(null)} onSelect={onSelect} />}
          {selTask && (
            <div className="flex flex-col h-full">
              <div className="flex items-start gap-2 px-4 pt-4 pb-3 border-b">
                <StatusIcon status={selTask.status} className="size-4 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium leading-snug">{selTask.goal}</div>
                  <div className="mono text-[11px] text-muted-foreground mt-1 flex gap-3">
                    <span>{selTask.id}</span>
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{STATUS_LABEL[selTask.status]}</Badge>
                    <span>{elapsed(selTask.updatedAt, now)} ago</span>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={() => onSelect(null)}>
                  <X className="size-4" />
                </Button>
              </div>
              <div className="px-4 py-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => navigate(`/task/${selTask.id}`)}>
                    <ExternalLink className="size-3.5" /> Open session
                  </Button>
                  {selTask.status === "needs_review" && (
                    <Button size="sm" variant="outline" onClick={() => onAction(selTask, "approve")}>
                      Approve merge
                    </Button>
                  )}
                  {HOLDABLE.includes(selTask.status) && (
                    <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => onAction(selTask, selTask.hold ? "release" : "hold")}>
                      {selTask.hold ? "Release hold" : "Hold for review"}
                    </Button>
                  )}
                </div>
                {(() => {
                  const b = city?.byTask.get(selTask.id);
                  const files = b ? b.files : selTask.files;
                  return files.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {files.map((f) => (
                        <button key={f} type="button" onClick={() => onSelect(`file:${projectId}:${f}`)} className="mono text-[11px] text-left rounded-md border px-2 py-1 hover:bg-accent/50 truncate">
                          {f}
                        </button>
                      ))}
                    </div>
                  ) : null;
                })()}
                {(() => {
                  const b = city?.byTask.get(selTask.id);
                  return b && b.commits.length > 0 ? (
                    <div>
                      <div className="eyebrow mb-1.5">Commits</div>
                      {b.commits.map((c, i) => (
                        <button key={c.id} type="button" onClick={() => onSelect(c.id)} className="w-full text-left text-xs rounded-md px-2 py-1 hover:bg-accent/50 flex gap-2">
                          <span className="scene-seq">{i + 1}</span>
                          <span className="mono text-blue-500 shrink-0">{short(c.sha)}</span>
                          <span className="truncate">{c.message}</span>
                        </button>
                      ))}
                    </div>
                  ) : null;
                })()}
                {selTask.summary && <div className="text-xs text-muted-foreground max-h-60 overflow-auto"><Prose text={selTask.summary} /></div>}
              </div>
            </div>
          )}
          {!selPos && !selTask && selMerge === null && !selected?.startsWith("file:") && <p className="p-4 text-xs text-muted-foreground">Nothing here.</p>}
        </aside>
      )}
    </div>
  );
}
