"use client";

import { ExternalLink, FileCode2, GitCommitHorizontal, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { FleetStrip } from "@/components/FleetStrip";
import { StatusIcon } from "@/components/StatusIcon";
import { Timeline } from "@/components/Timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type ActivityEvent, api, type CommitDetail, elapsed, type FileDetail, type HistoryItem, navigate, short, type StateView, STATUS_LABEL } from "@/lib/api";

const Scene = dynamic(() => import("@/components/Scene"), { ssr: false, loading: () => <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Loading the scene…</div> });

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
          {d && d.parents.length > 0 && (
            <div className="mono text-[11px] text-muted-foreground">parents {d.parents.map((p) => short(p)).join(", ")}</div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function FilePanel({ projectId, path, state, onClose, onOpenCommit }: { projectId: string; path: string; state: StateView | null; onClose: () => void; onOpenCommit: (sha: string) => void }) {
  const [d, setD] = useState<FileDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    setErr(null);
    api<FileDetail>(`/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`).then(setD).catch((e) => setErr(String(e)));
  }, [projectId, path]);
  const touching = state?.tasks.filter((t) => t.files.includes(path)) ?? [];
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start gap-2 px-4 pt-4 pb-3 border-b">
        <FileCode2 className="size-4 mt-0.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="mono text-sm font-medium break-all">{path}</div>
          <div className="mono text-[11px] text-muted-foreground mt-1">{d ? `${d.bytes} bytes${d.truncated ? " · truncated" : ""}` : ""}</div>
        </div>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-3 space-y-4">
          {err && <p className="text-xs text-red-400">{err}</p>}
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
  const projectId = state?.project?.id ?? "sample-api";
  const selTask = shown?.tasks.find((t) => t.id === selected) ?? null;
  const selPos = shown?.positions.find((p) => p.id === selected) ?? null;
  const hovTask = shown?.tasks.find((t) => t.id === hovered) ?? null;
  const panelWidth = selected ? "right-[400px]" : "right-0";
  return (
    <div className="relative h-full">
      <div className={`absolute inset-y-0 left-0 ${panelWidth} transition-[right] duration-200`}>
        {shown ? <Scene state={shown} selected={selected} hovered={hovered} onSelect={onSelect} onHover={onHover} activity={activity} dark={dark} now={replayAt ?? now} /> : null}
        <div className="absolute top-3 left-3 glass rounded-lg px-3 py-1.5 mono text-[11px] text-muted-foreground flex items-center gap-4">
          <span>main <span className="text-foreground">{short(shown?.project?.head)}</span></span>
          <span>{shown?.positions.filter((p) => p.kind === "file").length ?? 0} files</span>
          <span>{shown?.positions.filter((p) => p.kind === "commit").length ?? 0} commits</span>
          <span>{shown?.tasks.filter((t) => ["running", "queued", "ready", "merging", "approved", "needs_review"].includes(t.status)).length ?? 0} in flight</span>
          {state && !state.index && <span className="text-amber-500">index off</span>}
          {replayAt !== null && <span className="text-blue-500">replay</span>}
        </div>
        {hovTask && !selected && (
          <div className="absolute top-14 left-3 glass rounded-lg px-3 py-2 text-xs max-w-[420px] pointer-events-none">
            <div className="mono text-muted-foreground">{hovTask.id} · {STATUS_LABEL[hovTask.status]}</div>
            <div>{hovTask.goal}</div>
          </div>
        )}
        <div className="absolute left-3 bottom-16 w-[380px] max-w-[calc(100%-24px)]">
          {shown && <FleetStrip tasks={shown.tasks} activity={activity} selected={selected} onSelect={(id) => onSelect(id)} now={replayAt ?? now} />}
        </div>
        <div className="absolute left-3 right-3 bottom-3">
          <Timeline history={history} start={timeStart} end={now} at={replayAt} onScrub={onScrub} />
        </div>
      </div>
      {selected && (
        <aside className="absolute inset-y-0 right-0 w-[400px] border-l bg-background">
          {selPos?.kind === "commit" && selPos.meta?.sha && <CommitPanel projectId={projectId} sha={selPos.meta.sha} onClose={() => onSelect(null)} onOpenFile={(path) => onSelect(`file:${projectId}:${path}`)} />}
          {selPos?.kind === "file" && <FilePanel projectId={projectId} path={selPos.label} state={state} onClose={() => onSelect(null)} onOpenCommit={(sha) => onSelect(`commit:${projectId}:${sha}`)} />}
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
                <Button size="sm" onClick={() => navigate(`/task/${selTask.id}`)}>
                  <ExternalLink className="size-3.5" /> Open session
                </Button>
                {selTask.files.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {selTask.files.map((f) => (
                      <button key={f} type="button" onClick={() => onSelect(`file:${projectId}:${f}`)} className="mono text-[11px] text-left rounded-md border px-2 py-1 hover:bg-accent/50 truncate">
                        {f}
                      </button>
                    ))}
                  </div>
                )}
                {selTask.summary && <p className="text-xs text-muted-foreground whitespace-pre-wrap max-h-60 overflow-auto">{selTask.summary}</p>}
              </div>
            </div>
          )}
          {!selPos && !selTask && <p className="p-4 text-xs text-muted-foreground">Nothing here.</p>}
        </aside>
      )}
    </div>
  );
}
