"use client";

import { FolderGit2, GitFork, Link2, Map as MapIcon } from "lucide-react";

import { Prompt, type LaunchMode } from "@/components/Prompt";
import { Radar } from "@/components/Radar";
import { Button } from "@/components/ui/button";
import { navigate, type StateView } from "@/lib/api";

export function Home({
  state,
  projectId,
  now,
  busy,
  onLaunch,
  onAddProject,
  onQuick,
}: {
  state: StateView | null;
  projectId: string;
  now: number;
  busy: boolean;
  onLaunch: (goals: string[], mode: LaunchMode) => Promise<void>;
  onAddProject: () => void;
  onQuick: (kind: "artifacts" | "github" | "url") => void;
}) {
  const live = state?.tasks.filter((t) => ["running", "queued", "ready", "merging", "approved"].includes(t.status)).length ?? 0;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 pt-16 pb-16 flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <div className="size-16 rounded-2xl border bg-card grid place-items-center">
            <span className="size-4 rounded-full bg-blue-500 shadow-[0_0_18px_rgba(59,130,246,0.9)]" />
          </div>
          {live > 0 && (
            <Button variant="link" size="sm" className="text-muted-foreground" onClick={() => navigate("/map")}>
              <MapIcon className="size-3.5" /> {live} agent{live === 1 ? "" : "s"} working · watch the map
            </Button>
          )}
        </div>
        <Prompt state={state} busy={busy} onLaunch={onLaunch} onAddProject={onAddProject} />
        <div className="flex flex-wrap justify-center gap-2 text-sm">
          <Button variant="ghost" size="sm" className="text-foreground/85" onClick={() => onQuick("artifacts")}>
            <FolderGit2 className="size-4 text-muted-foreground" /> Use an Artifacts repository
          </Button>
          <Button variant="ghost" size="sm" className="text-foreground/85" onClick={() => onQuick("github")}>
            <GitFork className="size-4 text-muted-foreground" /> Import from GitHub
          </Button>
          <Button variant="ghost" size="sm" className="text-foreground/85" onClick={() => onQuick("url")}>
            <Link2 className="size-4 text-muted-foreground" /> Clone from URL
          </Button>
        </div>
        <Radar tasks={state?.tasks ?? []} projectId={projectId} now={now} />
      </div>
    </div>
  );
}
