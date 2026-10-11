"use client";

import { CheckCircle2, CircleDashed, CircleDot, CircleOff, GitMerge, GitPullRequest, Loader2, OctagonAlert, XCircle } from "lucide-react";

import type { TaskStatus } from "@/lib/api";

export function StatusIcon({ status, className = "size-4" }: { status: TaskStatus; className?: string }) {
  switch (status) {
    case "queued":
      return <CircleDashed className={`${className} text-muted-foreground`} />;
    case "running":
      return <Loader2 className={`${className} text-blue-500 animate-spin`} />;
    case "ready":
      return <CircleDot className={`${className} text-foreground`} />;
    case "merging":
      return <GitMerge className={`${className} text-blue-500`} />;
    case "needs_review":
      return <GitPullRequest className={`${className} text-amber-500`} />;
    case "approved":
      return <GitPullRequest className={`${className} text-blue-500`} />;
    case "merged":
      return <CheckCircle2 className={`${className} text-foreground/80`} />;
    case "blocked":
      return <OctagonAlert className={`${className} text-red-400`} />;
    case "failed":
      return <XCircle className={`${className} text-red-400`} />;
    case "abandoned":
      return <CircleOff className={`${className} text-muted-foreground`} />;
  }
}
