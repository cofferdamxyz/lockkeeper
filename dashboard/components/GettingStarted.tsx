"use client";

import { Button } from "@/components/ui/button";
import type { StateView } from "@/lib/api";

export interface SetupStep {
  key: string;
  title: string;
  done: boolean;
  action: string;
  busy: boolean;
  hint?: string;
  run: () => void;
}

/** The five things a deployment needs before the first agent runs, each read from the state. */
export function setupSteps(
  state: StateView,
  act: { bootstrap: () => void; register: () => void; push: () => void; index: () => void; launch: () => void },
): SetupStep[] {
  const building = state.bootstrapStatus === "starting" || state.bootstrapStatus === "installing";
  const failed = state.bootstrapStatus?.startsWith("failed") ? state.bootstrapStatus : undefined;
  return [
    { key: "image", title: "Build the agent image", done: state.snapshot, action: failed ? "Build again" : "Build", busy: building, hint: building ? "a few minutes" : failed, run: act.bootstrap },
    { key: "register", title: "Register the project", done: state.project !== null, action: "Register", busy: false, run: act.register },
    { key: "push", title: "Push your code", done: !!state.project?.head, action: "Show me how", busy: false, run: act.push },
    { key: "index", title: "Index the repository", done: !!state.project?.hasMap, action: "Index", busy: false, run: act.index },
    { key: "launch", title: "Launch an agent", done: state.tasks.length > 0, action: "Launch", busy: false, run: act.launch },
  ];
}

/** A small card with the next step as a button; gone once every step is done. */
export function GettingStarted({ steps, busy }: { steps: SetupStep[]; busy: boolean }) {
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  if (!next) return null;
  const r = 8.5;
  const c = 2 * Math.PI * r;
  return (
    <div className="mx-2 mb-2 rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Getting started</span>
        <span className="ml-auto mono text-xs text-muted-foreground">
          {done}/{steps.length}
        </span>
        <svg width="20" height="20" viewBox="0 0 20 20" className="-rotate-90" aria-hidden>
          <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" className="text-border" strokeWidth="2" />
          <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" className="text-blue-500" strokeWidth="2" strokeDasharray={c} strokeDashoffset={c * (1 - done / steps.length)} strokeLinecap="round" />
        </svg>
      </div>
      <p className="mt-1 text-xs text-muted-foreground truncate">
        {next.title}
        {next.hint ? ` · ${next.hint.slice(0, 48)}` : ""}
      </p>
      <Button size="sm" className="mt-2 w-full" disabled={busy || next.busy} onClick={next.run}>
        {next.busy ? "Building…" : next.action}
      </Button>
    </div>
  );
}
