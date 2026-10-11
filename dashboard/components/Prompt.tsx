"use client";

import { ArrowUp, ChevronDown, FolderGit2, GitBranch, GitFork, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { short, type StateView } from "@/lib/api";

export type LaunchMode = "auto" | "review";

export function Prompt({
  state,
  busy,
  onLaunch,
  onAddProject,
  compact = false,
}: {
  state: StateView | null;
  busy: boolean;
  onLaunch: (goals: string[], mode: LaunchMode) => Promise<void>;
  onAddProject: () => void;
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<LaunchMode>("auto");
  const goals = text.split("\n").map((g) => g.trim()).filter(Boolean);
  const submit = async () => {
    if (goals.length === 0 || busy) return;
    await onLaunch(goals, mode);
    setText("");
  };
  return (
    <div className="w-full">
      <div className="rounded-2xl border bg-card shadow-sm focus-within:border-foreground/30 transition-colors">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          rows={compact ? 2 : 3}
          placeholder="Describe a change. One line per agent; each works in its own fork and the lock decides how they merge."
          className="border-0 shadow-none focus-visible:ring-0 bg-transparent resize-none text-[15px] px-4 pt-4 min-h-0"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setText((t) => (t ? `${t}\n` : t))} aria-label="Add a line">
            <Plus className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground gap-1" onClick={() => setMode((m) => (m === "auto" ? "review" : "auto"))}>
            {mode === "auto" ? "Auto merge" : "Hold for review"} <ChevronDown className="size-3.5" />
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
      <div className="mt-2 flex flex-wrap items-center gap-1 text-sm">
        <Button variant="ghost" size="sm" className="gap-1.5 text-foreground/90">
          <FolderGit2 className="size-4 text-muted-foreground" /> {state?.project?.id ?? "project"} <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
        <Button variant="ghost" size="sm" className="gap-1.5 text-foreground/90" disabled>
          <GitFork className="size-4 text-muted-foreground" /> New fork per task
        </Button>
        <Button variant="ghost" size="sm" className="gap-1.5 text-foreground/90" disabled>
          <GitBranch className="size-4 text-muted-foreground" /> {state?.project?.defaultBranch ?? "main"} <span className="mono text-xs text-muted-foreground">{short(state?.project?.head)}</span>
        </Button>
        <Button variant="ghost" size="sm" className="gap-1.5 ml-auto text-foreground/90" onClick={onAddProject}>
          <Plus className="size-4 text-muted-foreground" /> Add project
        </Button>
      </div>
    </div>
  );
}
