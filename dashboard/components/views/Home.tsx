"use client";

import { GitFork, Hand, History, Lock, Plus } from "lucide-react";
import { useRef, useState } from "react";

import { FleetSummary } from "@/components/FleetSummary";
import { Prompt, type LaunchMode } from "@/components/Prompt";
import { Radar } from "@/components/Radar";
import { Button } from "@/components/ui/button";
import { navigate, type StateView } from "@/lib/api";

/** The demo's goal set: three changes, two of them overlapping, so the lock has something to decide. */
const STARTER_GOALS = ["Add input validation with tests", "Add a rate-limiting middleware with tests", "Split the router into modules"];

export function Home({
  state,
  projectId,
  now,
  busy,
  onLaunch,
  onAddProject,
  onReplayLast,
}: {
  state: StateView | null;
  projectId: string;
  now: number;
  busy: boolean;
  onLaunch: (goals: string[], mode: LaunchMode) => Promise<void>;
  onAddProject: () => void;
  onReplayLast: () => void;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<LaunchMode>("auto");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focus = () => inputRef.current?.focus();
  const waiting = state?.tasks.filter((t) => ["needs_review", "blocked", "failed"].includes(t.status)).length ?? 0;
  const landed = state?.merges.some((m) => m.main_after) ?? false;
  // Starters do things: fill the box, switch the mode, open the lock, replay. None opens a dialog of commands.
  const starters = [
    { icon: GitFork, title: "Split a change into agents", body: "Three goals, three forks; the lock lands them in order", run: () => { setText(STARTER_GOALS.join("\n")); focus(); }, disabled: false },
    { icon: Hand, title: "Hold everything for review", body: "Agents work; nothing merges until you approve", run: () => { setMode("review"); focus(); }, disabled: false },
    { icon: Lock, title: "Open the lock", body: waiting > 0 ? `${waiting} change${waiting === 1 ? "" : "s"} waiting for you` : "See what is waiting to enter main", run: () => navigate("/map"), disabled: false },
    { icon: History, title: "Replay the last session", body: landed ? "Watch what landed and why" : "Once something has merged", run: onReplayLast, disabled: !landed },
  ];
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 pt-14 pb-16 flex flex-col items-center gap-7">
        <FleetSummary tasks={state?.tasks ?? []} now={now} />
        <Prompt state={state} busy={busy} text={text} mode={mode} onText={setText} onMode={setMode} onLaunch={onLaunch} inputRef={inputRef} autoFocus />
        <ul className="w-full divide-y border-y">
          {starters.map((s) => (
            <li key={s.title}>
              <button type="button" disabled={s.disabled} onClick={s.run} className="w-full flex items-center gap-3 px-2 py-3 text-left rounded-md hover:bg-accent/30 disabled:opacity-50 disabled:hover:bg-transparent">
                <span className="size-8 rounded-lg border bg-card grid place-items-center shrink-0">
                  <s.icon className="size-4" />
                </span>
                <span className="text-sm font-medium shrink-0">{s.title}</span>
                <span className="text-sm text-muted-foreground truncate">{s.body}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="w-full flex items-center gap-2 text-sm -mt-3">
          <span className="text-muted-foreground">{projectId}</span>
          <Button variant="ghost" size="sm" className="ml-auto text-foreground/85" onClick={onAddProject}>
            <Plus className="size-4 text-muted-foreground" /> Add project
          </Button>
        </div>
        <Radar tasks={state?.tasks ?? []} projectId={projectId} now={now} />
      </div>
    </div>
  );
}
