"use client";

import { CheckCircle2, ChevronDown, FileSearch, FileText, GitCommitHorizontal, Pencil, Search, Terminal, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Prose } from "@/components/Prose";
import { groupEvents, headline, SIGNAL, type Step } from "@/lib/activity";
import type { ActivityEvent, TaskView } from "@/lib/api";

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const { tool, result } = step;
  const Icon = tool.name === "Bash" ? Terminal : tool.name === "Edit" || tool.name === "Write" || tool.name === "MultiEdit" ? Pencil : tool.name === "Grep" || tool.name === "Glob" ? Search : tool.name === "Read" ? FileSearch : FileText;
  const { title, rest } = headline(tool);
  const failed = result !== null && !result.ok;
  const signal = result !== null && (failed || SIGNAL.test(result.text));
  const preview = result?.text.split("\n").filter((l) => l.trim()).slice(0, failed ? 4 : 2).join("\n") ?? "";
  const expandable = rest > 0 || (result !== null && result.text.length > 0);
  return (
    <div className="relative pl-6">
      <span className={`absolute left-[7px] top-[9px] size-2 rounded-full ${failed ? "bg-red-400" : tool.name === "Bash" ? "bg-blue-500" : "bg-foreground/50"}`} />
      <button type="button" onClick={() => expandable && setOpen((o) => !o)} className={`w-full text-left flex items-start gap-2 text-xs rounded-md px-1 py-0.5 ${expandable ? "hover:bg-accent/40" : "cursor-default"}`}>
        <Icon className={`size-3.5 shrink-0 mt-0.5 ${failed ? "text-red-400" : "text-muted-foreground"}`} />
        <span className={`${tool.name === "Bash" ? "mono" : ""} text-foreground/90 break-words min-w-0 flex-1`}>
          {title}
          {rest > 0 && <span className="text-muted-foreground"> · +{rest} more</span>}
        </span>
        {expandable && <ChevronDown className={`size-3.5 shrink-0 mt-0.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />}
      </button>
      {!open && signal && preview && <pre className={`mono text-[11px] whitespace-pre-wrap break-words pl-6 pr-2 ${failed ? "text-red-400" : "text-muted-foreground"}`}>{preview}</pre>}
      {open && (
        <div className="pl-6 pr-2 pb-1 space-y-1">
          {tool.name === "Bash" && rest > 0 && <pre className="mono text-[11px] whitespace-pre-wrap break-words text-foreground/80">{tool.summary}</pre>}
          {result && <pre className={`mono text-[11px] whitespace-pre-wrap break-words ${failed ? "text-red-400" : "text-muted-foreground"}`}>{result.text}</pre>}
        </div>
      )}
    </div>
  );
}

/** The agent's run: what it was told, what it did step by step, what it said, how it ended, what it committed. */
export function ActivityStream({ task, events, brief, live }: { task: TaskView; events: ActivityEvent[]; brief: string | null; live: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  const [showBrief, setShowBrief] = useState(false);
  useEffect(() => {
    if (live) endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [events.length, live]);
  const items = groupEvents(events);
  return (
    <div className="flex flex-col gap-3">
      {brief !== null && (
        <div className="rounded-xl border bg-card">
          <button type="button" onClick={() => setShowBrief((b) => !b)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left">
            <span className="eyebrow">What the agent was told</span>
            <span className="text-xs text-muted-foreground truncate flex-1">{showBrief ? "" : brief ? brief.split("\n")[0].slice(0, 90) : "No other work was in flight."}</span>
            <ChevronDown className={`size-3.5 text-muted-foreground transition-transform ${showBrief ? "rotate-180" : ""}`} />
          </button>
          {showBrief && <div className="px-4 pb-3 text-xs text-muted-foreground whitespace-pre-wrap">{brief || "No other work was in flight."}</div>}
        </div>
      )}
      {events.length === 0 && <p className="text-sm text-muted-foreground px-1">{task.status === "queued" ? "Waiting for a sandbox…" : "No activity recorded."}</p>}
      <div className="relative flex flex-col gap-1.5">
        <span className="absolute left-[10px] top-2 bottom-2 w-px bg-border" aria-hidden />
        {items.map((e, i) => {
          if (e.kind === "start")
            return (
              <div key={i} className="relative pl-6 text-xs text-muted-foreground py-0.5">
                <span className="absolute left-[7px] top-[7px] size-2 rounded-full bg-blue-500" />
                Agent started{e.model ? ` · ${e.model}` : ""}
              </div>
            );
          if (e.kind === "step") return <StepRow key={i} step={e} />;
          if (e.kind === "result")
            return (
              <div key={i} className="relative pl-6 text-xs text-red-400">
                <span className="absolute left-[7px] top-[7px] size-2 rounded-full bg-red-400" />
                <pre className="mono whitespace-pre-wrap break-words">{e.text}</pre>
              </div>
            );
          if (e.kind === "note")
            return (
              <div key={i} className="relative pl-6 py-1">
                <span className="absolute left-[7px] top-[14px] size-2 rounded-full bg-foreground/70" />
                <div className="rounded-xl border bg-card px-4 py-3 text-sm">
                  <Prose text={e.text} />
                </div>
              </div>
            );
          return (
            <div key={i} className="relative pl-6 py-1">
              <span className={`absolute left-[7px] top-[14px] size-2 rounded-full ${e.ok ? "bg-foreground" : "bg-red-400"}`} />
              <div className={`rounded-xl border px-4 py-3 text-sm ${e.ok ? "bg-card" : "border-red-400/30 bg-red-400/5"}`}>
                <div className="flex items-center gap-2 eyebrow mb-2">
                  {e.ok ? <CheckCircle2 className="size-3.5 text-foreground" /> : <XCircle className="size-3.5 text-red-400" />}
                  {e.ok ? "Finished" : "Failed"}
                  {e.costUsd != null && <span className="ml-auto mono normal-case tracking-normal">${e.costUsd.toFixed(3)} · {e.turns ?? "?"} turns</span>}
                </div>
                <Prose text={e.text} />
              </div>
            </div>
          );
        })}
        {live && (
          <div className="relative pl-6 flex items-center gap-2 text-xs text-blue-500 py-0.5">
            <span className="absolute left-[7px] top-[7px] size-2 rounded-full bg-blue-500 animate-pulse" /> working…
          </div>
        )}
      </div>
      {task.commits.length > 0 && (
        <div className="rounded-xl border bg-card px-4 py-3">
          <div className="eyebrow mb-2">Commits · {task.commits.length}</div>
          <ol className="space-y-1">
            {[...task.commits].reverse().map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="scene-seq mt-0.5">{i + 1}</span>
                <GitCommitHorizontal className="size-3.5 mt-0.5 text-muted-foreground shrink-0" />
                <span>{c}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
