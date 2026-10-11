/** Prompts the harness hands to Claude Code. Kept in one place so the rules read as one text. */

export function agentPrompt(p: {
  taskId: string;
  goal: string;
  conventions: string | null;
  brief: string;
  testCommand: string;
}): string {
  return [
    `You are one of several coding agents working on this repository at the same time. You work alone in your own fork; a merge Workflow later decides how your change and the others' land on main. Task id: ${p.taskId}.`,
    ``,
    `## Goal`,
    p.goal,
    ``,
    `## What other agents are doing right now`,
    p.brief || "No other work is in flight.",
    ``,
    `## Project conventions`,
    p.conventions ?? "No conventions file was found. Follow the code style you see.",
    ``,
    `## Rules of the lock`,
    `- Stay inside the goal. Do not refactor, rename or reformat files the goal does not need; another agent may be editing them.`,
    `- When your goal and another agent's work touch the same file, keep your change small and additive so the merge stays clean.`,
    `- Run the tests with \`${p.testCommand}\` before you finish and make them pass. Add tests for behaviour you add.`,
    `- Work in small commits, three or four where the goal allows: for example a failing test, the implementation, then cleanup or docs. Each commit message states the step in one line, then explains it. Never squash into one commit at the end. Do not push; the harness pushes your fork.`,
    `- Do not install new dependencies unless the goal requires them, and say so in the commit message if you do.`,
    `- Finish with a short summary of what changed, which files, and anything the merge should know.`,
  ].join("\n");
}

export function resolverPrompt(p: {
  taskId: string;
  candidateGoal: string;
  mergedGoals: string[];
  conflictedFiles: string[];
  testCommand: string;
}): string {
  return [
    `You are resolving a merge conflict in this repository. A change from task ${p.taskId} is being merged onto main, and main already contains other agents' work. Both intents must survive.`,
    ``,
    `## The change being merged`,
    p.candidateGoal,
    ``,
    `## What already merged into main`,
    p.mergedGoals.map((g) => `- ${g}`).join("\n") || "- (unknown)",
    ``,
    `## Conflicted files`,
    p.conflictedFiles.map((f) => `- ${f}`).join("\n"),
    ``,
    `## Rules`,
    `- Resolve every conflict marker so that both the merged work and the incoming change keep their behaviour.`,
    `- Do not drop either side's tests. Do not touch files outside the conflict unless a test forces you to.`,
    `- Run \`${p.testCommand}\` and make it pass.`,
    `- Finish the merge with \`git add -A && git commit --no-edit\` (the merge message is prepared). Do not push.`,
    `- End with one paragraph describing how you reconciled the two changes.`,
  ].join("\n");
}
