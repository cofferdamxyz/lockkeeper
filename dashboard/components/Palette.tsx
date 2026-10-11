"use client";

import { Check, FileCode2, Moon, Plus, Sun } from "lucide-react";

import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { isLive, type PositionView, STATUS_LABEL, type TaskView } from "@/lib/api";

export function Palette({
  open,
  onOpenChange,
  tasks,
  files,
  selected,
  onNewTask,
  onSelect,
  onApprove,
  onToggleTheme,
  dark,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tasks: TaskView[];
  files: PositionView[];
  selected: TaskView | null;
  onNewTask: () => void;
  onSelect: (id: string) => void;
  onApprove: (id: string) => void;
  onToggleTheme: () => void;
  dark: boolean;
}) {
  const live = tasks.filter((t) => isLive(t.status));
  const done = tasks.filter((t) => !isLive(t.status)).slice(-12).reverse();
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Lockkeeper" description="Launch, approve, jump">
      <CommandInput placeholder="Type a goal, a task id, a file…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => { onOpenChange(false); onNewTask(); }}>
            <Plus /> New tasks <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          {selected?.status === "needs_review" && (
            <CommandItem onSelect={() => { onOpenChange(false); onApprove(selected.id); }}>
              <Check /> Approve merge of {selected.id.slice(-4)}
            </CommandItem>
          )}
          <CommandItem onSelect={() => { onOpenChange(false); onToggleTheme(); }}>
            {dark ? <Sun /> : <Moon />} {dark ? "Light scheme" : "Dark scheme"}
          </CommandItem>
        </CommandGroup>
        {live.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="In flight">
              {live.map((t) => (
                <CommandItem key={t.id} value={`${t.id} ${t.goal}`} onSelect={() => { onOpenChange(false); onSelect(t.id); }}>
                  <span className="mono text-xs text-muted-foreground">{t.id.slice(-4)}</span>
                  <span className="truncate">{t.goal}</span>
                  <CommandShortcut>{STATUS_LABEL[t.status]}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {done.length > 0 && (
          <CommandGroup heading="Recent">
            {done.map((t) => (
              <CommandItem key={t.id} value={`${t.id} ${t.goal}`} onSelect={() => { onOpenChange(false); onSelect(t.id); }}>
                <span className="mono text-xs text-muted-foreground">{t.id.slice(-4)}</span>
                <span className="truncate">{t.goal}</span>
                <CommandShortcut>{STATUS_LABEL[t.status]}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {files.length > 0 && (
          <CommandGroup heading="Files">
            {files.map((f) => (
              <CommandItem key={f.id} value={f.label} onSelect={() => { onOpenChange(false); onSelect(f.id); }}>
                <FileCode2 /> <span className="mono text-xs">{f.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
