/**
 * Clef is Cloudflare's non-generative decision model. One request carries a `state` and up to
 * 64 questions; each answer is a probability (`noul`), a chosen option with per-option
 * probabilities (`choice`), or a probability-weighted score (`score`). The advising pass builds
 * the request (`advice.ts`); this file holds the shapes and the tolerant reading of the answer.
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

export const RISK_LEVELS = ["No risk to other changes", "Minor risk", "Major risk", "Critical risk"];

export interface Decision {
  next: string | null;
  nextProbabilities: Record<string, number>;
  unattended: Record<string, number>;
  risk: Record<string, number>;
  raw: unknown;
}

/** Tolerant reading of Clef's answers; the raw response is kept beside the parsed values. */
export function parseDecision(raw: unknown, candidateIds: string[]): Decision {
  const answers = ((raw as { answers?: Record<string, unknown> })?.answers ?? {}) as Record<string, unknown>;
  const decision: Decision = { next: null, nextProbabilities: {}, unattended: {}, risk: {}, raw };
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
