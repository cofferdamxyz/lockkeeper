"use client";

import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Palette } from "@/components/Palette";
import type { LaunchMode } from "@/components/Prompt";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Home } from "@/components/views/Home";
import { MapView } from "@/components/views/MapView";
import { TaskView } from "@/components/views/TaskView";
import { TasksView } from "@/components/views/TasksView";
import { type ActivityEvent, api, getToken, type HistoryItem, navigate, projectFromUrl, replayState, setToken, type StateView, type TaskStatus, type TaskView as TaskRow } from "@/lib/api";

const ANNOUNCE: Partial<Record<TaskStatus, (t: TaskRow) => void>> = {
  ready: (t) => toast(`${t.id.slice(-4)} is ready`, { description: t.goal.slice(0, 80) }),
  merged: (t) => toast.success(`${t.id.slice(-4)} merged into main`, { description: t.goal.slice(0, 80) }),
  needs_review: (t) => toast.warning(`${t.id.slice(-4)} waits at the gate`, { description: t.error?.slice(0, 100) ?? "held for review", action: { label: "Open", onClick: () => navigate(`/task/${t.id}`) } }),
  failed: (t) => toast.error(`${t.id.slice(-4)} failed`, { description: t.error?.slice(0, 100) }),
  blocked: (t) => toast.error(`${t.id.slice(-4)} is blocked`, { description: t.error?.slice(0, 100) }),
};

type Quick = "artifacts" | "github" | "url" | "project" | null;

function useRoute(): string {
  const [route, setRoute] = useState("/");
  useEffect(() => {
    const read = () => setRoute(window.location.hash.replace(/^#/, "") || "/");
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return route;
}

export default function Dashboard() {
  const route = useRoute();
  const [project] = useState(projectFromUrl);
  const [state, setState] = useState<StateView | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activity, setActivity] = useState<Record<string, ActivityEvent[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quick, setQuick] = useState<Quick>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const prevStatuses = useRef<Map<string, TaskStatus> | null>(null);
  const prevConflict = useRef(new Set<number>());
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  const taskId = route.startsWith("/task/") ? route.slice("/task/".length) : null;

  useEffect(() => setHasToken(getToken() !== null), []);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api<StateView>(`/api/state?project=${encodeURIComponent(project)}`);
      setState(s);
      const prev = prevStatuses.current;
      const next = new Map(s.tasks.map((t) => [t.id, t.status]));
      if (prev) {
        for (const t of s.tasks) {
          const was = prev.get(t.id);
          if (was && was !== t.status) ANNOUNCE[t.status]?.(t);
        }
        const conflict = s.merges.find((m) => m.conflict && !m.resolved_by && next.get(m.task_id) === "merging");
        if (conflict && !prevConflict.current.has(conflict.id)) {
          prevConflict.current.add(conflict.id);
          toast.warning(`${conflict.task_id.slice(-4)} conflicts with main`, { description: "the resolver agent is on it" });
        }
      }
      prevStatuses.current = next;
    } catch (e) {
      toast.error("Lost the Worker", { description: String(e).slice(0, 120), id: "conn" });
    }
  }, [project]);

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
    const ids = state.tasks.filter((t) => t.status === "running" || t.id === taskId || t.id === selected).map((t) => t.id);
    const entries = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await api<{ events: ActivityEvent[] }>(`/api/tasks/${id}/events`);
          return [id, r.events] as const;
        } catch {
          return null;
        }
      }),
    );
    setActivity((a) => ({ ...a, ...Object.fromEntries(entries.filter((e): e is readonly [string, ActivityEvent[]] => e !== null)) }));
  }, [state, taskId, selected]);

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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown = useMemo(() => (state && replayAt !== null ? replayState(state, history, replayAt) : state), [state, history, replayAt]);
  const files = useMemo(() => state?.positions.filter((p) => p.kind === "file") ?? [], [state]);
  const timeStart = useMemo(() => {
    const first = history[0]?.at ?? state?.tasks[0]?.createdAt;
    return first ? new Date(first).getTime() : now - 60_000;
  }, [history, state, now]);
  const current = taskId ? (state?.tasks.find((t) => t.id === taskId) ?? null) : null;

  async function launch(goals: string[], mode: LaunchMode) {
    setBusy(true);
    try {
      const r = await api<{ tasks: { id: string }[] }>(`/api/tasks`, { method: "POST", body: JSON.stringify({ project, goals, mode }) });
      toast(`${r.tasks.length} agent${r.tasks.length === 1 ? "" : "s"} launched`, { action: { label: "Watch", onClick: () => navigate("/map") } });
      await refresh();
      if (r.tasks.length === 1) navigate(`/task/${r.tasks[0].id}`);
      else navigate("/map");
    } catch (e) {
      toast.error("Launch failed", { description: String(e).slice(0, 160) });
    } finally {
      setBusy(false);
    }
  }
  async function act(task: TaskRow, action: "approve" | "retry" | "abandon") {
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

  const remote = state?.project?.remote ?? "<remote>";
  const quickCopy: Record<Exclude<Quick, null>, { title: string; body: string; code: string }> = {
    artifacts: { title: "Use an Artifacts repository", body: "Lockkeeper works on a repository in its own Artifacts namespace. Register the project, then push your code to it with a short-lived write token.", code: `curl -X POST -H "Authorization: Bearer $TOKEN" $URL/api/projects/${project}/register\ncurl -X POST -H "Authorization: Bearer $TOKEN" $URL/api/projects/${project}/token\ngit -c http.extraHeader="Authorization: Bearer <write token>" push ${remote} main` },
    github: { title: "Import from GitHub", body: "Artifacts imports public HTTPS remotes directly. Private repositories reach it through a push from CI with a write token.", code: `# in the Worker: env.ARTIFACTS.import({ source: { url: "https://github.com/<owner>/<repo>", branch: "main" }, target: { name: "${project}" } })` },
    url: { title: "Clone from URL", body: "Any public git URL can seed the project repository; the project's main becomes the base every agent forks from.", code: `git clone <url> && cd <repo>\ngit -c http.extraHeader="Authorization: Bearer <write token>" push ${remote} main` },
    project: { title: "Add project", body: "Projects are declared in lockkeeper.config.ts (repository, conventions file, test command, merge mode) and registered once.", code: `curl -X POST -H "Authorization: Bearer $TOKEN" $URL/api/projects/<id>/register` },
  };

  return (
    <div className="fixed inset-0 flex overflow-hidden">
      <Sidebar route={route} projectId={project} tasks={state?.tasks ?? []} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} onSearch={() => setPaletteOpen(true)} onAddProject={() => setQuick("project")} dark={dark} onToggleTheme={() => setTheme(dark ? "light" : "dark")} />
      <main className="flex-1 min-w-0 h-full">
        {route === "/" && <Home state={state} projectId={project} now={now} busy={busy} onLaunch={launch} onAddProject={() => setQuick("project")} onQuick={setQuick} />}
        {route === "/tasks" && <TasksView tasks={state?.tasks ?? []} now={now} />}
        {route === "/map" && (
          <MapView state={state} shown={shown} history={history} activity={activity} selected={selected} hovered={hovered} onSelect={setSelected} onHover={setHovered} replayAt={replayAt} onScrub={setReplayAt} timeStart={timeStart} now={now} dark={dark} />
        )}
        {taskId && current && <TaskView task={current} state={state} activity={activity[current.id] ?? []} now={now} busy={busy} dark={dark} onAction={(t, a) => void act(t, a)} />}
        {taskId && !current && state && <div className="h-full grid place-items-center text-sm text-muted-foreground">No task {taskId}.</div>}
      </main>
      <Palette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        tasks={state?.tasks ?? []}
        files={files}
        selected={current}
        onNewTask={() => navigate("/")}
        onSelect={(id) => {
          if (id.startsWith("t-")) navigate(`/task/${id}`);
          else {
            setSelected(id);
            navigate("/map");
          }
        }}
        onApprove={(id) => {
          const t = state?.tasks.find((x) => x.id === id);
          if (t) void act(t, "approve");
        }}
        onToggleTheme={() => setTheme(dark ? "light" : "dark")}
        dark={dark}
      />
      <Dialog open={quick !== null} onOpenChange={(o) => !o && setQuick(null)}>
        <DialogContent className="sm:max-w-lg">
          {quick && (
            <>
              <DialogHeader>
                <DialogTitle>{quickCopy[quick].title}</DialogTitle>
                <DialogDescription>{quickCopy[quick].body}</DialogDescription>
              </DialogHeader>
              <pre className="mono text-[11px] rounded-lg bg-muted/50 p-3 whitespace-pre-wrap break-words">{quickCopy[quick].code}</pre>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
