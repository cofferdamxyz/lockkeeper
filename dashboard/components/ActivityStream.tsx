"use client";

import { CheckCircle2, FileText, Pencil, Terminal, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";

import type { ActivityEvent, TaskView } from "@/lib/api";

function ToolRow({ e }: { e: Extract<ActivityEvent, { kind: "tool" }> }) {
  const Icon = e.name === "Bash" ? Terminal : e.name === "Edit" || e.name === "Write" || e.name === "MultiEdit" ? Pencil : FileText;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground pl-1">
      <Icon className={`size-3.5 shrink-0 ${e.name === "Bash" ? "text-blue-500" : ""}`} />
      <span className="mono truncate">{e.summary}</span>
    </div>
  );
}

/** The agent's run as a conversation: notes as messages, tools as compact rows, the outcome last. */
export function ActivityStream({ task, events, live }: { task: TaskView; events: ActivityEvent[]; live: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [events.length, live]);
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border bg-card px-4 py-3">
        <div className="eyebrow mb-1">Task</div>
        <p className="text-sm">{task.goal}</p>
      </div>
      {events.length === 0 && <p className="text-sm text-muted-foreground px-1">{task.status === "queued" ? "Waiting for a sandbox…" : "No activity recorded."}</p>}
      {events.map((e, i) => {
        if (e.kind === "start") return <div key={i} className="text-xs text-muted-foreground px-1">Agent started{e.model ? ` · ${e.model}` : ""}</div>;
        if (e.kind === "tool") return <ToolRow key={i} e={e} />;
        if (e.kind === "result") {
          if (e.ok) return null;
          return (
            <div key={i} className="flex gap-2 text-xs text-red-400 pl-1">
              <XCircle className="size-3.5 shrink-0 mt-0.5" />
              <span className="mono break-words">{e.text}</span>
            </div>
          );
        }
        if (e.kind === "note") return <div key={i} className="rounded-xl border bg-card px-4 py-3 text-sm whitespace-pre-wrap">{e.text}</div>;
        return (
          <div key={i} className={`rounded-xl border px-4 py-3 text-sm whitespace-pre-wrap ${e.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-400/30 bg-red-400/5"}`}>
            <div className="flex items-center gap-2 eyebrow mb-1">
              {e.ok ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <XCircle className="size-3.5 text-red-400" />}
              {e.ok ? "Finished" : "Failed"}
              {e.costUsd != null && <span className="ml-auto mono normal-case tracking-normal">${e.costUsd.toFixed(3)} · {e.turns ?? "?"} turns</span>}
            </div>
            {e.text}
          </div>
        );
      })}
      {live && (
        <div className="flex items-center gap-2 text-xs text-blue-500 px-1">
          <span className="size-1.5 rounded-full bg-blue-500 animate-pulse" /> working…
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
