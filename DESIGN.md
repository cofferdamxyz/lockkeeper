# Lockkeeper

## 1. What it is

Lockkeeper lets many coding agents work on one repository at the same time
without stepping on each other, and decides, change by change, what merges
into `main`. It plays the part GitHub's coding agent plays, with two
differences: everything runs on Artifacts, and the work is visible as it
happens. Each agent works alone in its own Artifacts fork. A Vectorize
index of everything in flight tells each agent what the others are doing
before it starts. When agents finish, a Workflow asks Clef, Cloudflare's
calibrated decision model, which change should merge next, whether it may
merge without a human, and how much risk it carries for the work still in
flight. Changes merge one at a time in a dedicated sandbox, where they are
rebased onto `main`, tested, and either merged, handed to a human, or sent
back to an agent with a note of what changed underneath them.

The name is the one metaphor: a canal lock moves boats between water levels
one chamber at a time, and the lockkeeper sets the order. Everything else
uses the names Cloudflare developers already know.

| Term | Cloudflare primitive | Meaning here |
|---|---|---|
| project | Artifacts repository | the canonical repository, `main` is the truth |
| fork | `repo.fork()` + `createToken()` | one isolated repository per task, one scoped token |
| agent | Claude Code running headless | the process working on one task |
| sandbox | container Durable Object (Sandbox SDK) | where an agent runs; one named instance is the merge sandbox |
| index | Vectorize index | vectors for tasks in flight and merged changes |
| brief | — | the context an agent receives at start, built from the index |
| event | Queues event subscription | an Artifacts push, fork or delete arriving on the queue |
| merge Workflow | Workflow | collects ready tasks, asks Clef, performs merges in order |
| decision | Clef response | the recorded answers for one merge round |
| decision log | Artifacts repository | the why behind each merge, versioned in git |
| dashboard, map | Next.js static export + React Three Fiber on Workers static assets | the camera scene over the index, with the panels |

## 2. Why a merge queue is not enough

A merge queue takes pull requests in arrival order and serialises CI. With
agents that is the wrong unit and the wrong order: agents start from stale
context, produce overlapping work, and arrive together. Lockkeeper changes
three things.

- **Context before work.** The index holds every task in flight and every
  merged change. A new agent receives a brief of the nearest in-flight work
  and the latest merged changes in the same area, so overlap is reduced at
  the source.
- **Order by decision, not by clock.** Clef scores the ready set as a whole
  and picks the next change to merge: least overlap with the others,
  smallest blast radius, green tests, age as a tiebreaker. After each merge
  the question is asked again, because `main` moved.
- **Conflicts are work, not failures.** A conflict in the merge sandbox
  starts a resolver agent that already has both intents and the test suite;
  a resolution is a new candidate that goes back to Clef, never an
  automatic merge.

### 2.1 Answering the brief

The competition asks for "the Git platform of the agentic era", not GitHub
with agents added on top, and its announcement poses three questions: how
agents know what other agents are working on, what happens when they make
conflicting changes, and how to keep track of why a change was made.
Lockkeeper's answers are the index and the brief, the merge Workflow with
its sandbox and resolver, and a decision log written into git history.
Mapped onto what a git platform is made of:

| A git platform has | Lockkeeper has |
|---|---|
| Repository hosting | Artifacts repositories; `git clone` works for humans with a read token from the dashboard |
| Branches and forks | Artifacts forks with a one-hour scoped token, created per task and deleted after the merge |
| Pull requests | Merge candidates decided by Clef and recorded as decisions with probabilities instead of threads |
| Code review | Clef over the whole ready set, comparing the changes against each other; a human gate for what Clef declines |
| CI and deploy | Tests in the merge sandbox before the merge; Workers Builds after it |
| Merge queue | The merge Workflow: Clef-ordered, one merge sandbox, decided again after every merge |
| Conflict resolution | A resolver agent that holds both intents and the test suite |
| History and blame | `git log` with trailers `Lockkeeper-Task` and `Lockkeeper-Decision` on every merge commit; the decision log repository versions the why beside the what |
| Collaboration UI | The dashboard (§7): the index in three dimensions, live |
| Agent context | The index, the briefs, the decision log: versioned storage for agent context, as the announcement asks |

Humans keep plain git. A merge is an ordinary merge commit; the difference
is that its trailers name the task and the decision, and the decision log
holds the goal, the brief, the agent's summary and Clef's answers for that
commit.

## 3. Components

| Component | Cloudflare primitive | Role |
|---|---|---|
| Project repository | Artifacts repo `lockkeeper/<project>`, production branch `main` | Truth for the project; Workers Builds deploys every merge; mirrored to GitHub |
| Forks | `repo.fork("task-<id>")` + `createToken("write", 3600)` | One isolated fork per task; a token reaches one fork only |
| Lockkeeper Worker | Worker (Hono) + D1 | API, dashboard assets, task ledger, orchestration entry points |
| Agent sandboxes | Container Durable Objects (`durable_object` scheduling policy) running Claude Code | One agent per task, started with the goal, the conventions and the brief. The image is Cloudflare's managed `cloudflare/debian-trixie` plus a one-time bootstrap snapshot (git, ripgrep, Claude Code), so no Docker build is needed anywhere |
| Index | Vectorize `lockkeeper-index` (1024 dims, cosine) + Workers AI `@cf/baai/bge-m3` | One vector per task revision; metadata `{task, status, paths, project}` |
| Events | Queue subscribed to `cf.artifacts.repo.pushed` on the project repository | Head and map refresh when `main` moves outside Lockkeeper; idempotent on commit SHA. Subscriptions are per repository, so fork pushes are reported by the harness instead |
| Merge Workflow | Workflow | Collects the ready set, asks Clef, runs the merge sandbox, asks again after each merge |
| Merge sandbox | One named sandbox with a clone of the project repository and real git | Rebase or merge, tests, resolver agent, merge push, GitHub mirror |
| Clef | Workers AI `@cf/cloudflare/clef` (`clef-flash` for the cheap questions) | `choice` (next), `noul` (may it merge unattended), `score` (risk to work in flight) |
| Dashboard | Next.js static export + React Three Fiber, served as the Worker's static assets | The index in 3D: repository map, agents, overlap edges, the merge gate; panel with approvals and launch |
| Decision log | Artifacts repo `lockkeeper/<project>-decisions` (planned, cut-list item) | One commit per task event (goal, brief, summary, decision): the why, versioned in git and clonable. The D1 `decisions` table is the record today |
| Spend meter | AI Gateway (authenticated, BYOK Anthropic) | Every Claude call from an agent goes through it; budget and logs in one place |

Bindings: `ARTIFACTS`, `SANDBOX` (container DO class `AgentSandbox`;
agent sandboxes are `agent-<task>`, the merge sandbox is `merge-<project>`,
the bootstrap sandbox is `bootstrap`), `AI`, `VECTORIZE`, `DB` (D1), the
queue consumer, `MERGE_WORKFLOW`, `ASSETS`. Vars: `AI_GATEWAY_ACCOUNT_ID`,
`AI_GATEWAY_ID`, `ARTIFACTS_NAMESPACE`, `CLAUDE_CODE_VERSION`. Secrets:
`AI_GATEWAY_TOKEN`, `DASHBOARD_TOKEN`, optional `GITHUB_DEPLOY_KEY`.
Projects, thresholds and the agent model live in `lockkeeper.config.ts`.

## 4. A task's life

1. **Launch.** `POST /tasks` with one goal per line. For each goal the
   Worker writes a `queued` row, forks the project repository into
   `task-<id>` (default branch only), embeds the goal, and queries the
   index for the five nearest vectors with status `running` or `ready`
   plus the nearest `merged` ones. The result becomes the *brief*: "Other
   agents are working on: … touching `src/limits.ts` (similarity 0.82).
   Merged since the base: … ".
2. **Sandbox start.** The Worker starts the task's sandbox with
   `enableInternet: false`, so every outbound request passes through the
   Worker, which allows only the AI Gateway, the Artifacts git host and the
   npm registry, and swaps the placeholder `ANTHROPIC_API_KEY` for the
   gateway token on the way out (the pattern from Cloudflare's Claude Code
   guide). The fork's 1-hour write token never enters the sandbox either:
   the Worker stores it against the sandbox's name, and the outbound gateway
   adds it to requests for that one repository's git URL. `git clone` and
   `git push` inside the sandbox carry no credentials at all.
3. **Work.** The harness runs `claude --print --output-format stream-json
   --verbose --dangerously-skip-permissions --no-session-persistence
   --model $MODEL -- <prompt>` with `IS_SANDBOX=1` and
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. The prompt is: the goal,
   the project's `AGENTS.md` (conventions, how to run tests), the brief,
   and the rules (commit with a message that states the intent; do not
   touch files outside the goal; run the tests before finishing). The
   stream's final `result` event gives the summary, cost and `is_error`,
   all recorded in D1.
4. **Ready.** While the agent works, the harness's thirty-second check
   pushes each new commit to the fork, so the map shows the branch
   growing and the ledger keeps the agent's commits even if the run later
   fails. When the agent exits, the harness commits anything uncommitted
   under the agent's own message, runs the test suite, pushes to the
   fork's `main`, captures
   `git diff --stat` and the diff (size-capped) against the base commit,
   and marks the task `ready` (or `failed` with the reason: no changes,
   tests red, agent error). The sandbox is destroyed.
5. **Index.** The harness reports the push itself, and the task is
   re-embedded from goal + changed paths + diff summary, so the index now
   describes real work, not an intention. Queue events (`pushed` on the
   project repository) cover what the harness cannot see: a human pushing
   to `main`, which refreshes the head and the repository map.
6. **Decide.** The merge Workflow runs whenever a task becomes ready and no
   merge is in progress (a D1 lease serialises it). Section 6 describes the
   decision and the merge sandbox.
7. **Merge.** The chosen change merges into `main` by a push from the merge
   sandbox with a 10-minute write token minted for the project repository.
   The merge commit carries the trailers `Lockkeeper-Task: <id>` and
   `Lockkeeper-Decision: <id>`, and the decision log receives the task's
   record. Workers Builds deploys it, the mirror pushes `main` to GitHub,
   the task's vector is updated to `merged`, and the fork is deleted after
   a grace period. The dashboard shows the deployed URL.

Statuses: `queued → running → ready → merging → merged`, with
`needs_review` (a person approves, which sets `approved`, then `merging`;
an approval survives a conflict the resolver fixes on the way in),
`blocked` (a resolution failed; one automatic restart from a fresh fork
with a new brief), `failed`, `abandoned`. A person may also hold any
change in flight so it never merges unattended, and release it; a released
change re-enters the lock and Clef decides again.

## 5. The index

What is embedded: `goal`, the changed paths, the diff summary (first lines
of `git diff --stat` and the commit messages), and, once merged, the
agent's own summary. Metadata: `{task, status, paths[], project, base,
head}`. Paths double as exact filters: overlap between two tasks is the
pair (cosine similarity, Jaccard of path sets), and both numbers go to
Clef.

The index is derived and rebuildable from D1 and git. It is also the
"vector brain" of decision 0006 in miniature: the same index shape, over
commits instead of CVs, is what Cofferdam OS will keep over the product
repositories.

## 6. The merge Workflow

**Candidate set.** All `ready` tasks, capped at 20 (Clef allows 64
questions: one `choice` plus a `noul` and a `score` per candidate).

**State** sent to Clef (JSON, truncated by Clef to its 65,536-token window
if ever needed): per candidate `id`, goal, files changed, diffstat, tests,
age in minutes, commit messages, and its overlap with every other
candidate; plus the last five merged changes with their paths.

**Questions.**

```json
{
  "model": "clef",
  "state": "<json above>",
  "questions": {
    "next": {
      "type": "choice",
      "instructions": "Which ready change should merge next? Prefer green tests, the smallest blast radius, the least overlap with the other ready changes, and the oldest on ties.",
      "criteria": { "t-a1": "adds rate limiting in src/limits.ts; 120 lines; tests green; overlaps t-b2 on src/index.ts (0.71)", "t-b2": "…" }
    },
    "unattended.t-a1": {
      "type": "noul",
      "instructions": "May change t-a1 merge into main with no human review? Yes only if its tests pass, it touches no file another ready change touches, it changes no dependency or infrastructure file, and its commit message explains the change."
    },
    "risk.t-a1": {
      "type": "score",
      "instructions": "How much risk does merging t-a1 pose to the other changes in flight?",
      "criteria": ["No risk to other changes", "Minor risk", "Major risk", "Critical risk"]
    }
  }
}
```

Clef returns, with no prose to parse, the chosen option and a probability
per option, a probability of "yes" per `noul`, and a probability-weighted
score per `score`. The whole request and response are stored in D1 as a
decision and shown on the dashboard.

**Rules.** Merge unattended when `unattended ≥ 0.80`, `risk ≤ 1.0` and the
tests are green in the merge sandbox; otherwise `needs_review`. If the
chosen candidate's tests are red, take the next by probability. After a
resolver agent touched a change, an unattended merge needs
`unattended ≥ 0.90`. The thresholds are configuration; they start
conservative because Clef has no history here yet. Every decision is later
compared with what happened (did the merge break the next build?), which
is the same calibration loop `COFFERDAM_ENGINE.md` E7 plans for the
matching engine.

**Merge sandbox.** In the merge sandbox:

```
git fetch project main && git checkout -B merge project/main
git fetch fork-<id> main
git merge --no-ff fork-<id>/main          # or rebase; configurable
npm test
git push project merge:main               # 10-minute write token, env only
```

A conflict starts the resolver: `claude --print …` in the merge sandbox's
working tree with the conflicted files, both goals (the one that merged and
the candidate), the instruction to keep both intents, and the test command.
A clean, green resolution is committed, pushed to the task's fork (a
fast-forward, so the fork now contains the resolved merge), re-embedded,
and goes back to Clef as a new revision. A failed resolution marks the task `blocked`; the Worker
restarts it once from a fresh fork of the new `main` with a brief that
lists what merged meanwhile, which is the awareness mechanism in reverse.

**Ask again.** After every merge the remaining candidates' overlaps are
recomputed against the new `main` and Clef is asked again. The sequence is
therefore decided one merge at a time, by Clef, never by arrival order.

## 7. The dashboard

Lockkeeper's user-facing shape is the one GitHub's coding agent made
familiar: hand over a task, an agent works it in isolation, you watch,
review and merge. The difference is that all of it runs on Artifacts, and
that watching is the point: the primary surface is a map of the repository
with the work on it, not a list of pull requests.

**Why a map.** GitHub's primary surface is the pull request list because
its users read every change. With a fork per task and agents producing
commits faster than anyone reads them, the unit of attention has to move
from the change to the region of code, and to the lock that orders what
lands. The map answers the questions a list cannot answer at a glance:
where work is happening and by whom, which two agents are about to
collide, what landed in the last hour and in what order, which parts of
the code are hot. One rule decides what goes on it: every element is
either an answer to one of those questions, backed by data the Worker
holds, or a control that changes what Lockkeeper or an agent does.
Anything else was cut.

**Shape.** The layout follows the coding-agent apps people already use: a
sidebar with the project and its sessions, a home screen whose centre is
the composer, a session view with the agent's stream beside map, diff
and decision tabs, a work list, and the Map view as the live
visualisation of what is happening in Artifacts. The home screen opens
with a one-line fleet summary (working, needs you, merged today, or "all
quiet"). The two decisions an operator makes before launching sit above
the composer as chips: where the agents start from (`main` at its sha)
and how their work lands (auto merge or hold for review, also ⇧Tab). One
goal per line launches one agent each. Under the composer, four starters
do things rather than open dialogs: fill the box with the demo's three
overlapping goals, switch to review mode, open the lock, replay the last
session. The radar's heading says what the list is for: needs you, in
flight, or recent. The sidebar ends with a getting-started card that
reads the state (image built, project registered, code pushed,
repository indexed, first agent launched), offers the next step as a
button and disappears when all five are done, then the deployment host
with the scheme toggle and a way to forget the token.

**Stack.** Next.js static export served as the Worker's assets, set in
Inter. three.js through React Three Fiber draws the map as a camera scene
in the language of Alex Harri's *Planes*: a near-black ground grid tinted
blue, thin lines, glassy plates, phong spheres, a tilted camera that
slowly orbits until you take it. shadcn/ui (Tailwind 4) is the chrome.
Dark by default; a light scheme is a toggle. Colour has one grammar, on
the map and in every list: hue means directory, the saturated accents
mean agents, amber means a change waits for a person, red means failed
or blocked, blue means the lock is acting (the lock ring, the now ring,
merging, a person's approval), and white means landed unattended. A
merge the resolver reconciled first is a double ring, not a colour.

**The map: the strata city.** The repository is the floor, time rises
above it, and `main` is the column at the lock.

- **Floor.** The repository as a radial tree. Rings are directory depth,
  sectors are directories sized by their subtrees, blocks are files with
  height by size and brightness by recent change. Inside a sector, files
  that change together sit side by side (a greedy seriation over the
  co-change counts in the indexed commits), and the test directory lands
  beside the source directory it changes with. The floor is `main`'s
  tree; a file a fork adds before it lands is a translucent ghost in its
  sector, and a file a merge removed inside the window stays as a ghost.
- **Height is time, at two speeds.** The window is a control (auto, 1h,
  3h, 12h, 2d); auto is the smallest standard window that holds every
  live task and the last four merges. Inside it, stretches with activity
  take the column at one rate and quiet stretches longer than twenty
  minutes fold into short breaks marked on the column with their length,
  so the last session fills the column however long ago it was. Ticks
  are clock times inside the stretches shown at full height. Older
  history sinks into the floor's brightness.
- **Plates are commits**, laid over the files each one touched. A stack
  over one footprint is a branch, A then B then C. Commits reach the map
  as they happen: while an agent works, the sandbox pushes each new
  commit to the fork on its thirty-second check and the Worker indexes it
  from the fork (`live: true`); when the merge lands, history indexing
  replaces those rows with the full ones. Two live agents on one file get
  a small lateral offset so both chains stay readable. A commit that
  spans files is linked along the rings (polar routing), never through
  the column.
- **The column is `main`.** A ring on it is a merge: white when Clef
  cleared it unattended, blue when a person approved it, and a double
  ring when the resolver agent reconciled a conflict first. Spokes point
  at the files that landed. At most three merges carry a label at a
  time, the latest lit ones plus the picked one; the panel lists the
  rest.
- **The lock chamber.** The discs stacked under the now ring are the
  changes waiting to enter `main`, in the order they will: merging now,
  approved, pinned, then Clef's choice, then held for review. Dragging a
  disc (or the arrows in the lock panel) pins the order; the Workflow
  takes the pinned candidate first and still asks Clef to score it, and
  the unattended rule still applies. "Let Clef decide" clears the pins.
- **Beacons are agents**, hovering over the file they are on now, read
  from the parsed activity stream: editing pulses, reading is dimmer,
  held is amber, blocked is red. A red halo marks a file two live agents
  are changing.
- **Status is visible.** A branch's thread is dashed while it waits for
  review, red when it failed or is blocked, faded when abandoned.
- **Selection is disclosure.** At rest, live work and the last three
  merges are lit and older strata are dim. Picking an agent, a file, a
  commit or a merge ring lights its subgraph and dims the rest. The lock
  panel, the session list and the scene share one selection.
- **The now ring is the scrubber.** Drag it down the column to replay:
  everything above it disappears and statuses replay from the history.
  The timeline along the bottom does the same with a slider.
- **Panels.** A file opens its content, the agents touching it, its
  commits and an overlap warning; a commit opens its message, files and
  session; a merge opens how it happened, Clef's gauges against the
  thresholds, the candidates it was weighed against and what landed; a
  task opens its files, its commits in order and its summary. A legend
  ("How to read") sits in the corner.

**The chrome (shadcn/ui).**

- A command palette (⌘K) launches goals, approves, and jumps to a task or a
  file. The sidebar lists the project's sessions with a status icon each.
- A task launched in review mode never merges unattended; the mode sits
  beside the prompt, the way an agent app offers interactive and auto.
- The session view is the agent's run as a record: a header of facts
  (base and head, tests, cost, duration, commits, the files it touched),
  what the agent was told (the brief, folded), then the run as a
  timeline where each tool call is paired with its result, shell lines
  read as their first command plus a count, outputs that carry a signal
  (test counts, commit shas, errors) show inline and the rest unfold on
  click, the agent's notes and its outcome render as prose, and its
  commits close the record in order. The record's sections are tabs on
  the header's bottom edge, the way a pull request page does it:
  activity, map (the city with this task lit, full width), diff (with
  the file count) and decision (Clef's answers as gauges with the
  threshold mark, the unattended score on the tab). Approve is the only
  accented action.
- Toasts announce ready, merged, conflict, needs review.

**Data.** `GET /api/state` carries the files, every commit with its
files (added and deleted marked, `live` while it sits on a fork), the
tasks with their pinned lock order, the merges and the decisions.
`GET /api/tasks/:id/events` is the parsed activity, `GET /api/history`
the timeline. Changes land by push, not polling: the page asks
`POST /api/live/ticket` for a single-use ticket and opens a WebSocket to
`/api/live?ticket=…`, served by a `LiveHub` Durable Object per project
(hibernating WebSockets). The Worker broadcasts on every push, status
change, merge and lock change; the page refetches on each message and
keeps a slow poll as the floor. `PUT /api/projects/:id/lock` pins the
order.

## 8. Isolation and secrets

- An agent's token reaches its fork only, lives one hour, and never
  enters the sandbox: the outbound gateway injects it per request.
- Sandboxes have no direct internet; the Worker's outbound handler allows
  three hosts and injects the gateway token. The Anthropic key never leaves
  AI Gateway.
- The project repository's write token is minted for ten minutes per merge.
- Nothing from Cofferdam's product code is in the demo repository;
  submissions are public and not confidential.

## 9. Storage

D1 tables: `projects` (id, repo, github_source, default_branch,
conventions_path, test_command, image, merge_mode), `tasks` (id, project,
goal, fork, status, base_sha, head_sha, files JSON, diffstat, tests_ok,
cost_usd, restarts, created_at, updated_at), `pushes` (task_id, ref,
before, after, commits JSON, at), `decisions` (candidates JSON, request
JSON, response JSON, chosen, at), `merges` (task_id, decision_id, mode,
main_before, main_after, conflict, resolved_by, approved_by, at), `events`
(type, payload JSON, at; unique on type + SHA for idempotency),
`positions` (vector_id, x, y, z, basis_id). Diffs over 64 KB go to R2
(optional, cut-list item).

## 10. The demo

Project `sample-api`: a small Hono Worker with a few JSON endpoints and a
vitest suite, pushed to the project repository and connected to Workers
Builds. Four goals launched together:

1. input validation with tests;
2. a rate-limiting middleware;
3. a `/health` endpoint reporting version and uptime;
4. split the router into modules (touches everything: the conflict
   generator).

A fifth goal launched later ("add caching headers to list endpoints")
shows the index at work: its brief names the rate limiter that merged and
the file layout after the split.

Video (5–10 minutes): the problem and the lock analogy; the architecture
diagram; launch; forks and sandboxes appearing; a brief shown inside a
prompt; the first Clef decision and merge with Workers Builds deploying;
the overlapping pair, Clef ordering the smaller first, the conflict, the
resolver, the `needs_review` card and the approval; GitHub receiving
`main`; the fifth task's brief; what this becomes inside Cofferdam.

## 11. Build plan

The plan as written on 2026-10-10; the change log at the end records
what shipped and when.

| Day | Morning | Afternoon | Checkpoint |
|---|---|---|---|
| Sat 10-11 | Scaffold: Worker (C3), bindings, D1 schema; project repo with `sample-api`; sandbox image (Claude Code, git, node); sandbox start → `claude -p` → harness commit, tests, push | Queue consumer; index upsert; repository map embedding and projection; brief; `/api/state` | One task runs end to end and shows in the state API |
| Sun 10-12 | Clef client and request builder; decision ledger; merge Workflow with merge sandbox, tests, merge push, trailers, cleanup; ask-again loop | Dashboard v1: map, agents, edges, merge gate, panel with approvals; `needs_review` | The four-goal scenario runs and is visible live |
| Mon 10-13 | Resolver path; decision log; Workers Builds connection; GitHub mirror; timeline | README with run instructions, LICENSE (MIT), diagram, AI Gateway budget; record the video; publish | Package complete |
| Tue 10-14 | Buffer: retakes, fixes | Publish, or submit, before 23:59 PDT (decision 0008) | — |

Cut list, in order, if the Sunday checkpoint slips: the timeline; the
GitHub mirror; the decision log (the ledger stays in D1); the resolver
agent (a conflict becomes `needs_review`); the fifth task; the live tail
(final summary only).

## 12. What Cofferdam keeps

- The delegated agent loop of `DEVELOPMENT_SETUP.md` §7.2: the same
  Worker with the `cofferdam-dev` namespace, mirrors of the product
  repositories, and pull-request merge mode.
- The Clef client, request builder, decision ledger and calibration loop,
  which are the finalist decision pass of `COFFERDAM_ENGINE.md` E1/E8 with
  a different state.
- The index pattern, which is the OS's rebuildable vector layer over
  commits and decisions from decision 0006.
- The dashboard, which becomes the engine's "what the matcher sees"
  transparency screen (`WORK_WALLET_DESIGN.md` §17) and the OS's view over
  its vector layer: the same projection, panel and timeline over CVs,
  listings and decisions instead of files and agents.

## 13. Deployment model

Lockkeeper is self-hosted, one deployment per organisation, inside that
organisation's own Cloudflare account: the same posture as the Cloudflare
OS wrapper. Code, forks, tokens, agent output, the Anthropic key on the
gateway and the decision ledger never leave the account, billing stays on
the organisation's plan, and Cloudflare Access decides who may look and who
may approve. It is not a multi-tenant service.

**Two deployments for Cofferdam.**

| Deployment | Hostname | Purpose |
|---|---|---|
| Demo | `lockkeeper-demo.cofferdam.xyz` | The public showcase: `sample-api`, the four goals, the video. Behind `DASHBOARD_TOKEN`. Torn down after the launch, or kept as the live demo linked from the README |
| Cofferdam | `lockkeeper.cofferdam.xyz` | The delegated agent loop of `DEVELOPMENT_SETUP.md` §7.2 over the product repositories, behind Cloudflare Access with the `cofferdam.cloudflareaccess.com` team, namespace `cofferdam-dev` |

**One deployment, many projects.** The `projects` table holds one project
repository per project, each with its own map basis, decision log and
conventions file; the dashboard switches between them. For Cofferdam the
projects are `cofferdam-api`, `cofferdam-attester`, `cofferdam-sdk`,
`base-contracts` and `cofferdam-app`. Sandboxes run Linux, so they can
test and lint the app but not build it for iOS; app tasks arrive as pull
requests that the Mac builds.

**What an organisation customises** (`lockkeeper.config.ts` at the
repository root, typed and non-secret, in the spirit of the OS wrapper's
`deployment.jsonc`):

- projects: GitHub source, Artifacts repository name, default branch,
  conventions file, test command, sandbox image variant (node and yarn,
  pnpm, Foundry for contracts);
- merge mode per project: `mirror` (the demo: merge into Artifacts `main`
  and push it to GitHub) or `pull-request` (Cofferdam: the merge sandbox
  pushes `lockkeeper/<task>` to GitHub and opens a pull request through a
  GitHub App; GitHub CI and a human merge there; the mirror brings `main`
  back and the index updates). In pull-request mode Clef still orders the
  candidates, decides which to open first, and labels each with its risk
  and "unattended-eligible" verdict for a later GitHub auto-merge rule;
- Clef thresholds and model routing (`clef` or `clef-flash`, the agent
  model, per-task spend cap);
- the sandboxes' outbound allowlist (gateway, Artifacts host, package
  registries the projects need);
- access: `token` for a demo, `access` with the organisation's team and the
  approver group, so every approval in the ledger carries an identity.

Secrets stay in Wrangler: the gateway token, the GitHub App key, the
dashboard token. The public repository is the template: an organisation
deploys it with
`npm create cloudflare@latest -- --template cofferdamxyz/lockkeeper`,
edits `lockkeeper.config.ts`, sets the secrets and runs `pnpm deploy`.

**Mirrors.** Public GitHub repositories enter Artifacts with `import`
(public HTTPS only); private ones use the GitHub Actions push mirror of
`DEVELOPMENT_SETUP.md` §5.1. Both land in the organisation's namespace and
become the project repositories the agents fork.

**Cofferdam OS.** The Cofferdam deployment later gains a custom gatekeeper
so Control Center agents can read the dashboard state and launch tasks
with approval, which is how the OS becomes the place where work is asked
for and Lockkeeper the place where it is done.

## 14. Risks and unknowns

- The container Durable Object API is new (`container.start()`,
  `container.exec()`, snapshots, outbound interception). The sandbox class
  uses `exec` for all file I/O, so it needs no shim in the image and works
  on the managed image without Docker.
- Claude Code headless needs the permissions bypass and `IS_SANDBOX=1`;
  a rejected gateway token fails only after about three minutes of
  retries, so the harness checks the gateway first.
- Vectorize upserts are visible after seconds, not instantly; briefs read
  D1 for in-flight tasks and the index for similarity.
- Clef starts uncalibrated here; the human gate and conservative
  thresholds cover that until decisions accumulate.
- Artifacts counts create, push, pull and clone as operations; a task
  costs roughly ten. The demo stays inside the 10,000 included per month.
- Container budget: an agent sandbox runs on `standard-1` (½ vCPU,
  4 GiB); five concurrent sandboxes for a few hours stay inside the
  Workers Paid allowance (375 vCPU-minutes, 25 GiB-hours a month) during
  development only barely, so idle sandboxes are destroyed promptly.


## Change log

- 2026-10-11 (night): the session view's map, diff and decision moved
  from a side panel into tabs on the header edge beside activity, one
  section at a time at every width.
- 2026-10-11 (night): the session view polished: a facts header with
  file chips, the brief shown, tool calls paired with their results and
  foldable, signal outputs inline, notes and outcomes as prose, the
  closing note no longer repeated by the outcome, commits listed in
  order.
- 2026-10-11 (evening, after looking at Cursor's agent home): the
  composer's decisions move above the box as chips with a ⇧Tab toggle;
  four starters that act replace the dialog buttons; a getting-started
  card with progress and an account row in the sidebar; one projects
  dialog holds the push and import recipes.
- 2026-10-11 (evening, after a design critique): time runs at two speeds
  on the column, with quiet stretches folded into labelled breaks and
  clock-time ticks; merge labels capped at three; one colour grammar
  across the map and the lists (amber waits for a person, red failed,
  blue the lock acting, white landed, a double ring for a resolved
  conflict); the home screen opens with a fleet summary and a radar
  that says what it is for.
- 2026-10-11 (afternoon): hold and release on any change in flight
  (`POST /api/tasks/:id/hold`); a released change re-enters the lock. The
  sandbox gives the agent a git identity. A page that outlived a deploy
  reloads itself once instead of freezing on missing chunks. The column
  labels every other tick, staggers merge labels and drops narrow
  sub-sector labels; the strata move every five seconds, not every tick.
- 2026-10-11: a change a person approved keeps its approval when the
  resolver agent reconciles a conflict on the way in; it no longer waits
  for a second approval (the conflict row records `approved_by`).
- 2026-10-11: the map rebuilt as the strata city (decision 0011 in the
  Cofferdam decision log): repository on the floor, time as height,
  `main` as the column with merge rings and the lock chamber, agents as
  beacons, live fork commits, the lock order override and the live hub.
  Replaces the concentric rings and orbital planes.
