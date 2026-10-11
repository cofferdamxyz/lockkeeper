import type { TaskRow } from "./db";

/**
 * Which ready change enters the lock next: a pinned order set from the dashboard wins, then
 * Clef's choice, then the oldest candidate. Clef still scores the chosen change either way.
 */
export function pickNext(slice: Pick<TaskRow, "id" | "lock_order">[], clefChoice: string | null): string {
  const pinned = slice.filter((t) => t.lock_order !== null).sort((a, b) => (a.lock_order ?? 0) - (b.lock_order ?? 0))[0];
  if (pinned) return pinned.id;
  if (clefChoice && slice.some((t) => t.id === clefChoice)) return clefChoice;
  return slice[0].id;
}

/** Statuses from which a person may hold or release a change. */
export const HOLDABLE = ["queued", "running", "ready", "needs_review"] as const;
