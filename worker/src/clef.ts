import type { LockkeeperEnv } from "./env";

/**
 * Clef is Cloudflare's non-generative decision model. One request carries a `state` and up to
 * 64 questions; each answer is a probability (`noul`), a chosen option with per-option
 * probabilities (`choice`), or a probability-weighted score (`score`).
 */
export type ClefQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface ClefRequest {
  model: "clef" | "clef-flash";
  state: string;
  questions: Record<string, ClefQuestion>;
}

export interface Candidate {
  id: string;
  goal: string;
  files: string[];
  diffstat: string;
  testsOk: boolean;
  ageMinutes: number;
  commits: string[];
  resolved: boolean;
  overlaps: { with: string; cosine: number; paths: number }[];
}

export interface RecentMerge {
  id: string;
  goal: string;
  files: string[];
  at: string;
}

export const RISK_LEVELS = ["No risk to other changes", "Minor risk", "Major risk", "Critical risk"];

export function summarizeCandidate(c: Candidate): string {
  const overlap = c.overlaps
    .filter((o) => o.cosine >= 0.5 || o.paths > 0)
    .map((o) => `${o.with} (cos ${o.cosine.toFixed(2)}, paths ${o.paths.toFixed(2)})`)
    .join("; ");
  return [
    c.goal.slice(0, 160),
    `${c.files.length} files`,
    c.diffstat.split("\n").pop()?.trim() ?? "",
    c.testsOk ? "tests green" : "tests red",
    overlap ? `overlaps ${overlap}` : "no overlap",
    c.resolved ? "touched by a resolver agent" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function buildMergeRequest(
  candidates: Candidate[],
  recent: RecentMerge[],
  model: "clef" | "clef-flash",
): ClefRequest {
  const state = JSON.stringify(
    {
      ready_changes: candidates.map((c) => ({
        id: c.id,
        goal: c.goal,
        files_changed: c.files,
        diffstat: c.diffstat,
        tests_pass: c.testsOk,
        age_minutes: c.ageMinutes,
        commit_messages: c.commits,
        touched_by_resolver: c.resolved,
        overlap_with_other_ready_changes: c.overlaps,
      })),
      recently_merged: recent,
    },
    null,
    1,
  );
  const questions: Record<string, ClefQuestion> = {};
  // A choice needs at least two options; with one candidate the order is settled.
  if (candidates.length > 1) {
    questions.next = {
      type: "choice",
      instructions:
        "Which ready change should merge into main next? Prefer green tests, the smallest blast radius, the least overlap with the other ready changes, and the oldest on ties.",
      criteria: Object.fromEntries(candidates.map((c) => [c.id, summarizeCandidate(c)])),
    };
  }
  for (const c of candidates) {
    questions[`unattended.${c.id}`] = {
      type: "noul",
      instructions: `May change ${c.id} merge into main with no human review? Yes only if its tests pass, it touches no file another ready change touches, it changes no dependency manifest or infrastructure file, and its commit messages explain the change.`,
    };
    questions[`risk.${c.id}`] = {
      type: "score",
      instructions: `How much risk does merging ${c.id} pose to the other changes in flight?`,
      criteria: RISK_LEVELS,
    };
  }
  return { model, state, questions };
}

export interface MergeDecision {
  next: string | null;
  nextProbabilities: Record<string, number>;
  unattended: Record<string, number>;
  risk: Record<string, number>;
  raw: unknown;
}

/** Tolerant reading of Clef's answers; the raw response is kept beside the parsed values. */
export function parseMergeDecision(raw: unknown, candidateIds: string[]): MergeDecision {
  const answers = ((raw as { answers?: Record<string, unknown> })?.answers ?? {}) as Record<string, unknown>;
  const decision: MergeDecision = { next: null, nextProbabilities: {}, unattended: {}, risk: {}, raw };
  const nextAnswer = answers.next as Record<string, unknown> | string | undefined;
  if (typeof nextAnswer === "string") decision.next = nextAnswer;
  else if (nextAnswer && typeof nextAnswer === "object") {
    const choice = (nextAnswer.choice ?? nextAnswer.answer ?? nextAnswer.value ?? nextAnswer.option) as string | undefined;
    if (typeof choice === "string") decision.next = choice;
    const probs = (nextAnswer.probabilities ?? nextAnswer.options ?? nextAnswer.scores) as Record<string, number> | undefined;
    if (probs && typeof probs === "object") decision.nextProbabilities = probs;
    if (!decision.next && Object.keys(decision.nextProbabilities).length) {
      decision.next = Object.entries(decision.nextProbabilities).sort((a, b) => b[1] - a[1])[0][0];
    }
  }
  for (const id of candidateIds) {
    decision.unattended[id] = numberFrom(answers[`unattended.${id}`]);
    decision.risk[id] = numberFrom(answers[`risk.${id}`]);
  }
  if (decision.next && !candidateIds.includes(decision.next)) decision.next = null;
  return decision;
}

function numberFrom(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Clef answers: { type: "noul", noul } and { type: "score", score, legend, probabilities, confidence }.
    for (const k of ["noul", "score", "probability", "value", "answer", "yes"]) {
      if (typeof o[k] === "number") return o[k] as number;
    }
  }
  return Number.NaN;
}

export async function runClef(env: Pick<LockkeeperEnv, "AI">, request: ClefRequest): Promise<unknown> {
  const model = request.model === "clef-flash" ? "@cf/cloudflare/clef-flash" : "@cf/cloudflare/clef";
  return env.AI.run(model as never, request as never);
}
