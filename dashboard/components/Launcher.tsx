"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";

export function Launcher({ open, onOpenChange, onLaunch, busy }: { open: boolean; onOpenChange: (o: boolean) => void; onLaunch: (goals: string[]) => Promise<void>; busy: boolean }) {
  const [text, setText] = useState("");
  const goals = text.split("\n").map((g) => g.trim()).filter(Boolean);
  const submit = async () => {
    if (goals.length === 0) return;
    await onLaunch(goals);
    setText("");
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New tasks</DialogTitle>
          <DialogDescription>One goal per line. Each becomes an agent working in its own fork; the lock decides how they merge.</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
          }}
          placeholder={"Add GET /berths/free listing unoccupied berths, with a test.\nValidate vessel names on POST /berths/:id/moor."}
          className="mono text-sm"
        />
        <DialogFooter className="items-center">
          <span className="text-xs text-muted-foreground mr-auto flex items-center gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd> to launch
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || goals.length === 0} onClick={() => void submit()}>
            Launch {goals.length || ""} agent{goals.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
