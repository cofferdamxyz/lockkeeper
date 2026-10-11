"use client";

import { FolderGit2, House, ListChecks, LogOut, Map as MapIcon, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Sun } from "lucide-react";

import { GettingStarted, type SetupStep } from "@/components/GettingStarted";
import { StatusIcon } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isLive, navigate, type TaskView } from "@/lib/api";

export function Sidebar({
  route,
  projectId,
  tasks,
  collapsed,
  onToggle,
  onSearch,
  onAddProject,
  dark,
  onToggleTheme,
  setup,
  busy,
  host,
  onForgetToken,
}: {
  route: string;
  projectId: string;
  tasks: TaskView[];
  collapsed: boolean;
  onToggle: () => void;
  onSearch: () => void;
  onAddProject: () => void;
  dark: boolean;
  onToggleTheme: () => void;
  setup: SetupStep[] | null;
  busy: boolean;
  host: string;
  onForgetToken: () => void;
}) {
  const nav = [
    { href: "/", label: "Home", icon: House },
    { href: "/tasks", label: "My work", icon: ListChecks },
    { href: "/map", label: "Map", icon: MapIcon },
  ];
  const sessions = [...tasks].sort((a, b) => (isLive(b.status) ? 1 : 0) - (isLive(a.status) ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 14);
  const active = (href: string) => (href === "/" ? route === "/" : route.startsWith(href));
  return (
    <aside className={`h-full border-r bg-sidebar text-sidebar-foreground flex flex-col ${collapsed ? "w-14" : "w-64"} transition-[width] duration-200`}>
      {/* Collapsed, the column is one icon wide: the toggle stands alone and the footer stacks. */}
      <div className={`h-12 flex items-center gap-2 ${collapsed ? "justify-center" : "px-3"}`}>
        {!collapsed && <span className="size-2.5 rounded-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.8)] shrink-0" />}
        {!collapsed && <span className="text-sm font-semibold tracking-tight">Lockkeeper</span>}
        <Button variant="ghost" size="icon" className={collapsed ? "size-8" : "ml-auto size-7"} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggle}>
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </Button>
      </div>
      <nav className="px-2 flex flex-col gap-0.5">
        {nav.map((n) => (
          <Tooltip key={n.href}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => navigate(n.href)}
                  className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent ${active(n.href) ? "bg-sidebar-accent font-medium" : "text-sidebar-foreground/80"}`}
                />
              }
            >
              <n.icon className="size-4 shrink-0" />
              {!collapsed && n.label}
            </TooltipTrigger>
            {collapsed && <TooltipContent side="right">{n.label}</TooltipContent>}
          </Tooltip>
        ))}
        <button type="button" onClick={onSearch} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent">
          <Search className="size-4 shrink-0" />
          {!collapsed && (
            <>
              Search <span className="ml-auto mono text-[10px] text-muted-foreground">⌘K</span>
            </>
          )}
        </button>
      </nav>
      {!collapsed && (
        <div className="mt-5 px-2 flex-1 min-h-0 flex flex-col">
          <div className="flex items-center px-2 pb-1">
            <span className="eyebrow">Sessions</span>
            <Button variant="ghost" size="icon" className="ml-auto size-6" aria-label="Add project" onClick={onAddProject}>
              <Plus className="size-3.5" />
            </Button>
          </div>
          <div className="overflow-auto flex-1 min-h-0">
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <FolderGit2 className="size-4 text-muted-foreground" />
              <span className="truncate font-medium">{projectId}</span>
            </div>
            {sessions.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => navigate(`/task/${t.id}`)}
                className={`w-full flex items-center gap-2 rounded-md pl-7 pr-2 py-1.5 text-left text-sm hover:bg-sidebar-accent ${route === `/task/${t.id}` ? "bg-sidebar-accent" : "text-sidebar-foreground/85"}`}
              >
                <StatusIcon status={t.status} className="size-3.5 shrink-0" />
                <span className="truncate">{t.goal}</span>
              </button>
            ))}
            {sessions.length === 0 && <p className="pl-7 pr-2 py-1 text-xs text-muted-foreground">No agents yet.</p>}
          </div>
        </div>
      )}
      <div className="mt-auto flex flex-col">
        {!collapsed && setup && <GettingStarted steps={setup} busy={busy} />}
        <div className={`p-2 flex items-center gap-1 border-t ${collapsed ? "flex-col" : ""}`}>
          {!collapsed && <span className="mono text-[11px] text-muted-foreground truncate px-1 flex-1" title={host}>{host}</span>}
          <Button variant="ghost" size="icon" className="size-8" aria-label="Toggle colour scheme" onClick={onToggleTheme}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Forget the dashboard token" onClick={onForgetToken}>
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
