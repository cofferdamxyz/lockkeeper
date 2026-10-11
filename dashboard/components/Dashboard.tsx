"use client";

import { Command as CommandIcon, Moon, Plus, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import Chart from "@/components/Chart";
import { FleetStrip } from "@/components/FleetStrip";
import { Launcher } from "@/components/Launcher";
import { Palette } from "@/components/Palette";
import { TaskSheet } from "@/components/TaskSheet";
import { Timeline } from "@/components/Timeline";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type ActivityEvent, api, getToken, type HistoryItem, isLive, projectFromUrl, replayState, setToken, short, type StateView, STATUS_LABEL, type TaskStatus, type TaskView } from "@/lib/api";

const ANNOUNCE: Partial<Record<TaskStatus, (t: TaskView) => void>> = {
  ready: (t) => toast(`${t.id.slice(-4)} is ready`, { description: t.goal.slice(0, 80) }),
  merged: (t) => toast.success(`${t.id.slice(-4)} merged into main`, { description: t.goal.slice(0, 80) }),
  needs_review: (t) => toast.warning(`${t.id.slice(-4)} waits at the gate`, { description: t.error?.slice(0, 100) ?? "Clef held it for review" }),
  failed: (t) => toast.error(`${t.id.slice(-4)} failed`, { description: t.error?.slice(0, 100) }),
  blocked: (t) => toast.error(`${t.id.slice(-4)} is blocked`, { description: t.error?.slice(0, 100) }),
};

export default function Dashboard() {
  const [project] = useState(projectFromUrl);
  const [state, setState] = useState<StateView | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activity, setActivity] = useState<Record<string, ActivityEvent[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const launchRef = useRef<HTMLButtonElement>(null);
  const [birthAt, setBirthAt] = useState<{ x: number; y: number } | null>(null);
  const prevStatuses = useRef<Map<string, TaskStatus> | null>(null);
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme !== "light";

  useEffect(() => setHasToken(getToken() !== null), []);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api<StateView>(`/api/state?project=${encodeURIComponent(project)}`);
      setState(s);
      setError(null);
      const prev = prevStatuses.current;
      const next = new Map(s.tasks.map((t) => [t.id, t.status]));
      if (prev) {
        for (const t of s.tasks) {
          const was = prev.get(t.id);
          if (was && was !== t.status) ANNOUNCE[t.status]?.(t);
          if (!was && t.status === "queued") toast(`${t.id.slice(-4)} launched`, { description: t.goal.slice(0, 80) });
        }
        const conflict = s.merges.find((m) => m.conflict && !m.resolved_by && next.get(m.task_id) === "merging");
        if (conflict && !prevConflict.current.has(conflict.id)) {
          prevConflict.current.add(conflict.id);
          toast.warning(`${conflict.task_id.slice(-4)} conflicts with main`, { description: "the resolver agent is on it" });
        }
      }
      prevStatuses.current = next;
    } catch (e) {
      setError(String(e));
    }
  }, [project]);
  const prevConflict = useRef(new Set<number>());

  const refreshHistory = useCallback(async () => {
    try {
      const h = await api<{ items: HistoryItem[] }>(`/api/history?project=${encodeURIComponent(project)}`);
      setHistory(h.items);
    } catch {
      // the timeline can wait
    }
  }, [project]);

  const refreshActivity = useCallback(async () => {
    if (!state) return;
    const ids = state.tasks.filter((t) => t.status === "running" || t.id === selected).map((t) => t.id);
    const entries = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await api<{ events: ActivityEvent[] }>(`/api/tasks/${id}/events`);
          return [id, r.events] as const;
        } catch {
          return [id, activity[id] ?? []] as const;
        }
      }),
    );
    setActivity((a) => ({ ...a, ...Object.fromEntries(entries) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, selected]);

  useEffect(() => {
    if (!hasToken) return;
    void refresh();
    void refreshHistory();
    const a = window.setInterval(() => void refresh(), 2500);
    const b = window.setInterval(() => void refreshHistory(), 10_000);
    return () => {
      window.clearInterval(a);
      window.clearInterval(b);
    };
  }, [hasToken, refresh, refreshHistory]);
  useEffect(() => {
    if (!hasToken) return;
    void refreshActivity();
    const id = window.setInterval(() => void refreshActivity(), 4000);
    return () => window.clearInterval(id);
  }, [hasToken, refreshActivity]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setLauncherOpen(true);
      } else if (e.key === "Escape") {
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = launchRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBirthAt({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }, [state?.project?.id]);

  const shown = useMemo(() => (state && replayAt !== null ? replayState(state, history, replayAt) : state), [state, history, replayAt]);
  const selectedTask = useMemo(() => shown?.tasks.find((t) => t.id === selected) ?? null, [shown, selected]);
  const files = useMemo(() => state?.positions.filter((p) => p.kind === "file") ?? [], [state]);
  const timeStart = useMemo(() => {
    const first = history[0]?.at ?? state?.tasks[0]?.createdAt;
    return first ? new Date(first).getTime() : now - 60_000;
  }, [history, state, now]);

  async function launch(goals: string[]) {
    setBusy(true);
    try {
      await api(`/api/tasks`, { method: "POST", body: JSON.stringify({ project, goals }) });
      await refresh();
    } catch (e) {
      toast.error("Launch failed", { description: String(e).slice(0, 160) });
    } finally {
      setBusy(false);
    }
  }
  async function act(task: TaskView, action: "approve" | "retry" | "abandon") {
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}/${action}`, { method: "POST" });
      toast(`${task.id.slice(-4)}: ${action}`);
      await refresh();
    } catch (e) {
      toast.error(`${action} failed`, { description: String(e).slice(0, 160) });
    } finally {
      setBusy(false);
    }
  }

  if (!hasToken) {
    return (
      <main className="h-screen grid place-content-center gap-3 text-center px-6">
        <h1 className="text-xl font-medium">Lockkeeper</h1>
        <p className="text-sm text-muted-foreground">Paste the dashboard token to continue. It stays in this browser.</p>
        <form
          className="flex gap-2 w-[min(440px,90vw)]"
          onSubmit={(e) => {
            e.preventDefault();
            if (tokenInput.trim()) {
              setToken(tokenInput.trim());
              setHasToken(true);
            }
          }}
        >
          <input type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="dashboard token" autoFocus className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" />
          <Button type="submit">Open</Button>
        </form>
      </main>
    );
  }

  const live = shown?.tasks.filter((t) => isLive(t.status)).length ?? 0;
  const merged = shown?.tasks.filter((t) => t.status === "merged").length ?? 0;

  return (
    <div className="fixed inset-0 overflow-hidden">
      <div className="absolute inset-0">
        {shown ? <Chart state={shown} selected={selected} hovered={hovered} onSelect={setSelected} onHover={setHovered} activity={activity} birthAt={birthAt} dark={dark} /> : <div className="h-full grid place-items-center text-sm text-muted-foreground">Connecting…</div>}
      </div>

      <header className="absolute top-3 left-3 right-3 flex items-center gap-3 pointer-events-none">
        <div className="glass rounded-xl px-3 py-1.5 flex items-center gap-2 pointer-events-auto">
          <span className="size-2 rounded-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.9)]" />
          <span className="text-sm font-medium">Lockkeeper</span>
          <span className="text-sm text-muted-foreground">/ {project}</span>
        </div>
        {state?.project && (
          <div className="glass rounded-xl px-3 py-1.5 mono text-[11px] text-muted-foreground flex items-center gap-4 pointer-events-auto">
            <span>main <span className="text-foreground">{short(shown?.project?.head)}</span></span>
            <span>{files.length} files</span>
            <span>{live} in flight</span>
            <span>{merged} merged</span>
            <span className={state.snapshot ? "text-emerald-500" : "text-amber-500"}>{state.snapshot ? "sandbox ready" : "no snapshot"}</span>
            {!state.index && <span className="text-amber-500">index off</span>}
            {replayAt !== null && <span className="text-blue-500">replay</span>}
          </div>
        )}
        {error && <div className="glass rounded-xl px-3 py-1.5 text-xs text-red-400 pointer-events-auto truncate max-w-[40vw]">{error}</div>}
        <div className="ml-auto flex items-center gap-2 pointer-events-auto">
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="sm" onClick={() => setPaletteOpen(true)} />}>
              <CommandIcon className="size-3.5" /> <Kbd>⌘K</Kbd>
            </TooltipTrigger>
            <TooltipContent>Launch, approve, jump</TooltipContent>
          </Tooltip>
          <Button ref={launchRef} size="sm" onClick={() => setLauncherOpen(true)}>
            <Plus className="size-3.5" /> New tasks
          </Button>
          <Button variant="ghost" size="icon" aria-label="Toggle colour scheme" onClick={() => setTheme(dark ? "light" : "dark")}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </header>

      <div className="absolute left-3 bottom-16 w-[380px] max-w-[calc(100vw-24px)]">
        {shown && <FleetStrip tasks={shown.tasks} activity={activity} selected={selected} onSelect={setSelected} now={replayAt ?? now} />}
      </div>

      <div className="absolute left-3 right-3 bottom-3">
        <Timeline history={history} start={timeStart} end={now} at={replayAt} onScrub={setReplayAt} />
      </div>

      {hovered && !selected && shown && (() => {
        const t = shown.tasks.find((x) => x.id === hovered);
        const f = shown.positions.find((p) => p.id === hovered && p.kind === "file");
        const touching = f ? shown.tasks.filter((x) => x.files.includes(f.label)) : [];
        return (
          <div className="absolute left-3 top-16 glass rounded-xl px-3 py-2 text-xs max-w-[380px] pointer-events-none">
            {t && (
              <>
                <div className="mono text-muted-foreground">{t.id} · {STATUS_LABEL[t.status]}</div>
                <div>{t.goal}</div>
              </>
            )}
            {f && (
              <>
                <div className="mono">{f.label}</div>
                <div className="text-muted-foreground">{touching.length ? `touched by ${touching.map((x) => x.id.slice(-4)).join(", ")}` : "no agent touched this file"}</div>
              </>
            )}
          </div>
        );
      })()}

      <TaskSheet task={selectedTask} state={shown} activity={selectedTask ? activity[selectedTask.id] ?? [] : []} onClose={() => setSelected(null)} onAction={(t, a) => void act(t, a)} busy={busy} now={replayAt ?? now} />
      <Launcher open={launcherOpen} onOpenChange={setLauncherOpen} onLaunch={launch} busy={busy} />
      <Palette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        tasks={shown?.tasks ?? []}
        files={files}
        selected={selectedTask}
        onNewTask={() => setLauncherOpen(true)}
        onSelect={setSelected}
        onApprove={(id) => {
          const t = shown?.tasks.find((x) => x.id === id);
          if (t) void act(t, "approve");
        }}
        onToggleTheme={() => setTheme(dark ? "light" : "dark")}
        dark={dark}
      />
    </div>
  );
}
