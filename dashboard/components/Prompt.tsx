"use client";

import { ArrowUp, ChevronDown, GitBranch, Plus } from "lucide-react";
import type { RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { short, type StateView } from "@/lib/api";

export type LaunchMode = "auto" | "review";

/**
 * The composer. The two decisions an operator makes before launching, where the agents start
 * from and how their work lands, sit above the box as chips; the box itself is one goal per line.
 */
export function Prompt({
  state,
  busy,
  text,
  mode,
  onText,
  onMode,
  onLaunch,
  inputRef,
  compact = false,
  autoFocus = false,
}: {
  state: StateView | null;
  busy: boolean;
  text: string;
  mode: LaunchMode;
  onText: (text: string) => void;
  onMode: (mode: LaunchMode) => void;
  onLaunch: (goals: string[], mode: LaunchMode) => Promise<void>;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const goals = text.split("\n").map((g) => g.trim()).filter(Boolean);
  const submit = async () => {
    if (goals.length === 0 || busy) return;
    await onLaunch(goals, mode);
    onText("");
  };
  const toggle = () => onMode(mode === "auto" ? "review" : "auto");
  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-1 px-1 pb-2 text-sm">
        <span className="inline-flex items-center gap-1.5 px-1.5 text-muted-foreground">
          <GitBranch className="size-3.5" /> from {state?.project?.defaultBranch ?? "main"} <span className="mono text-xs">{short(state?.project?.head)}</span>
        </span>
        <span className="text-muted-foreground/40">·</span>
        <button type="button" onClick={toggle} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground/90 hover:bg-accent/60" aria-label="Merge mode">
          {mode === "auto" ? "Auto merge" : "Hold for review"} <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </div>
      <div className="rounded-2xl border bg-card shadow-sm focus-within:border-foreground/30 transition-colors">
        <Textarea
          ref={inputRef}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault();
              toggle();
            }
          }}
          rows={compact ? 2 : 3}
          placeholder="Describe a change. One line per agent; each works in its own fork and the lock decides how they land."
          className="border-0 shadow-none focus-visible:ring-0 bg-transparent resize-none text-[15px] px-4 pt-4 min-h-0"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onText(text ? `${text}\n` : text)} aria-label="Add a line">
            <Plus className="size-4" />
          </Button>
          <span className="text-xs text-muted-foreground ml-1">{state?.config.agents.model ?? ""}</span>
          <span className="ml-auto text-[11px] text-muted-foreground hidden sm:flex items-center gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </span>
          <Button size="icon" className="size-8 rounded-full" disabled={busy || goals.length === 0} onClick={() => void submit()} aria-label={`Launch ${goals.length} agents`}>
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 px-1">
        <button type="button" onClick={toggle} className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent/60">
          {mode === "auto" ? "Hold for review" : "Auto merge"} <Kbd>⇧</Kbd>
          <Kbd>Tab</Kbd>
        </button>
        {goals.length > 0 && <span className="text-xs text-muted-foreground">{goals.length === 1 ? "1 agent" : `${goals.length} agents`}</span>}
      </div>
    </div>
  );
}
