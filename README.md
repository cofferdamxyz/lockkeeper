# Lockkeeper

Many coding agents, one repository. Each agent works in its own
[Artifacts](https://developers.cloudflare.com/artifacts/) fork; an index
tells each agent what the others are doing before it starts; a Workflow
asks [Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
Cloudflare's calibrated decision model, which change should merge next,
whether it may merge without a person, and how much risk it carries for
the work still in flight. Merges happen one at a time in a sandbox with
real git and the project's tests. A dashboard shows the repository, the
agents and the merges as a city in which time rises above the code.

Everything runs in your own Cloudflare account: Workers, Artifacts,
Containers, Workers AI, Vectorize, D1, Queues, Workflows, AI Gateway and
Durable Objects. `DESIGN.md` explains how it works; `DEMO.md` is the
runbook for the recorded demo. MIT licensed; see `LICENSE`.

## Why another agent-driven git tool?

Coding-agent products ship one agent per pull request and leave the
coordination to the people reading those pull requests. That works while
agents are few. With a fork per task and agents producing commits faster
than anyone reads them, the pull request stops working as the unit of
attention: nobody tells the second agent what the first is changing,
conflicts surface at merge time when they are most expensive, and the
only view of the work is a list.

Lockkeeper makes three bets.

- **Coordination happens during the work, not at review.** Every agent
  starts with a brief built from an index of what is in flight and what
  recently merged near its goal, and its commits reach the dashboard as
  it makes them. Two agents on one file is visible before either is done.
- **Order and trust are decisions, so a decision model makes them.**
  Clef answers three questions per merge round with calibrated
  probabilities: which change next, may it land unattended, how much
  risk. The unattended threshold is a number you set, the resolver's
  work raises it, and a person can hold, release, approve or pin the
  order at any time.
- **The record is a map of the code over time, not a list.** Where work
  is happening and by whom, which agents are about to collide, what
  landed in what order and why, which parts of the code are hot. Every
  element on the map is a question an operator has or a command that
  changes what the lock does.

And one posture: it is self-hosted, one deployment per organisation,
built only from Cloudflare primitives. Code, forks, tokens and the model
key never leave the account, and no sandbox ever holds a credential.

## What it does today

**Isolation.** A fork of the project repository per task, with a
short-lived scoped token the sandbox never sees: the outbound gateway
injects it per request, along with the AI Gateway token. Sandboxes run
Cloudflare's managed Debian image from a snapshot Lockkeeper builds
itself, with no Internet beyond an allowlist of hosts. No Docker anywhere.

**Awareness.** Before an agent starts, Lockkeeper embeds its goal and
builds a brief from the index: the tasks in flight and the files they
touch, the merged changes nearest the goal. The agent's prompt carries
the brief, the project's conventions file and the rules of the lock.

**Agents.** Claude Code runs headless in the sandbox, asked to work in
small commits (a failing test, the implementation, then cleanup). The
harness pushes each new commit to the fork as it appears, runs the
project's tests when the agent finishes, and reports the diff, the
files and the commits. A person can work a task too: a fork and a
one-hour write token, then a submit call.

**The lock.** A Workflow collects the ready changes, asks Clef, and
merges the chosen one in a long-lived merge sandbox with real git and
the test suite. A conflict goes to a resolver agent in that sandbox and
the result is tested before it lands; a change Clef does not clear, or
one launched in review mode, waits for a person; an approval survives a
conflict the resolver fixes on the way in. A person can hold or release
any change in flight, approve, retry from a fresh fork, abandon, or pin
the order in which changes enter. Merge commits carry
`Lockkeeper-Task` and `Lockkeeper-Decision` trailers, and every decision
is kept.

**The map.** The repository is the floor: rings are directory depth,
sectors are directories, blocks are files, and files that change
together sit side by side. Time rises above it at two speeds, so a quiet
stretch folds into a short break and the last session always fills the
column. Commits are plates over the files they touched; a stack is a
branch, A then B then C. `main` is the column: a ring per merge, white
when it landed unattended, blue when a person approved it, doubled when
the resolver reconciled a conflict first, with spokes to what landed.
The discs under the now ring are the changes waiting to enter `main`, in
the order they will; drag one to pin the order. Agents hover over the
file they are on; a red halo marks a file two agents are changing.
Selecting anything lights its subgraph and dims the rest. Drag the now
ring down the column to replay. Updates arrive over a WebSocket the
moment they happen.

**The session view.** A record of the run: the facts (base and head,
tests, cost, duration, commits, files), what the agent was told, each
tool call paired with its result with the signal outputs inline, the
agent's notes and outcome as prose, the commits in order, and tabs for
the map, the diff and Clef's decision against the thresholds.

**The rest of the dashboard.** A home screen with a fleet summary, the
composer with the base and the merge mode as chips above it (⇧Tab
toggles the mode), starters that fill it, a radar that says what needs
you, a getting-started card that walks a new deployment through its
five setup steps, a command palette, a work list, and a timeline that
replays a run.

## How it works

1. `POST /api/tasks` with one goal per line forks the project
   repository per goal, embeds each goal, builds the brief and starts a
   sandbox.
2. The sandbox clones the fork and runs Claude Code; the harness pushes
   commits as they appear and the Worker indexes them from the fork.
3. When the agent exits, the harness runs the tests, pushes, and marks
   the task ready. A merge round starts.
4. The merge Workflow asks Clef over the ready set, merges the chosen
   change in the merge sandbox, runs the tests, and either pushes to
   `main`, starts the resolver, or holds the change for a person.
5. After each merge the repository map and the commit history are
   re-indexed, every open dashboard is told, and the round repeats until
   nothing is ready.

`DESIGN.md` has the full account: components, a task's life, the index,
the merge Workflow with Clef's request, the dashboard, isolation and
storage, the deployment model.

## Run it

Requirements: a Cloudflare account on the Workers Paid plan with Artifacts
enabled, an AI Gateway with an Anthropic key stored on it and an
authenticated-gateway token, Node 24 and pnpm. No Docker: the agent
sandbox is Cloudflare's managed Debian image plus a snapshot that
Lockkeeper builds itself.

```sh
pnpm install
cd worker
pnpm exec wrangler d1 create lockkeeper            # paste the id into wrangler.jsonc
pnpm exec wrangler queues create lockkeeper-events
pnpm exec wrangler vectorize create lockkeeper-index --dimensions=1024 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index lockkeeper-index --property-name=project --type=string
pnpm exec wrangler vectorize create-metadata-index lockkeeper-index --property-name=kind --type=string
pnpm exec wrangler vectorize create-metadata-index lockkeeper-index --property-name=status --type=string
pnpm exec wrangler d1 migrations apply lockkeeper --remote
cd .. && pnpm deploy                                # builds the dashboard, deploys the Worker
cd worker
pnpm exec wrangler secret put DASHBOARD_TOKEN       # any long random string
pnpm exec wrangler secret put AI_GATEWAY_TOKEN      # a Cloudflare API token with only "AI Gateway Run"
# after the project is registered (below), subscribe the queue to its pushes:
pnpm exec wrangler queues subscription create lockkeeper-events --source artifacts.repo --events pushed \
  --source-namespace lockkeeper --source-repo-name sample-api --name sample-api-pushes
```

The gateway needs authenticated mode on and the Anthropic key stored under
its provider keys; the sandboxes never see that key. Remove the `routes`
entry from `worker/wrangler.jsonc` or point it at your own hostname.

Then, with `T` set to the dashboard token and `URL` to the Worker:

```sh
curl -X POST -H "Authorization: Bearer $T" $URL/api/admin/bootstrap          # one-time snapshot, a few minutes
curl -H "Authorization: Bearer $T" $URL/api/admin/bootstrap                  # until "ready"
curl -X POST -H "Authorization: Bearer $T" $URL/api/projects/sample-api/register
curl -X POST -H "Authorization: Bearer $T" $URL/api/projects/sample-api/token  # a 10-minute write token
# push sample-api/ to the returned remote with: git -c http.extraHeader="Authorization: Bearer <token>" push <remote> main
curl -X POST -H "Authorization: Bearer $T" $URL/api/projects/sample-api/index  # the repository map
curl -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"goals":["add input validation with tests","add a rate-limiting middleware"]}' $URL/api/tasks
```

The dashboard's getting-started card does the same five steps from the
browser once the token is in. A person can also work a task:
`POST /api/tasks/manual` returns a fork and a one-hour write token; push,
then `POST /api/tasks/:id/submit` and the change enters the merge round
like an agent's.

Projects, Clef thresholds, the agent model and the sandboxes' outbound
allowlist live in `lockkeeper.config.ts`. Secrets never do.

## The dashboard

Open the Worker URL. The page asks for the dashboard token once and keeps
it in the browser; `?token=…` in the URL also works and is stripped on
load; the sign-out button at the bottom of the sidebar forgets it.
`GET /api/state`, `GET /api/tasks/:id/events`, `GET /api/history` and
the live socket at `/api/live` are everything the page renders.

To preview the built dashboard locally against a deployed Lockkeeper
without putting the token in a browser:

```sh
pnpm --filter dashboard build
node dashboard/dev-proxy.mjs --upstream https://<worker>.workers.dev --token-file ./secrets.env --port 8788
```

## The Cofferdam deployment (advice only)

A second Worker from the same code, `worker/wrangler.cofferdam.jsonc`
(`lockkeeper-cofferdam`, `lockkeeper.cofferdam.xyz`), for Cofferdam's own
development (workspace decision 0053, `DESIGN.md` §12–§13). It runs no
agent and merges nothing: its entry point, `worker/src/advise/`, imports
none of the runner, and `worker/test/advise-guard.test.ts` fails if it ever
does. It reads GitHub every five minutes through Lockkeeper's own GitHub
App, keeps the index and claims in its own D1 and Vectorize, and answers
behind Cloudflare Access:

| Route | What it answers |
|---|---|
| `GET /v1/brief?repo=&paths=&goal=&branch=` | The brief, as text: in flight near these paths, what landed recently, sensitive paths |
| `GET /v1/inflight?…` | The same as JSON |
| `POST /v1/check` `{repo, base, paths, branch}` | Before a commit or push: what moved on the default branch since `base` (read live), which files collide, other work on them |
| `POST /v1/claims` `{repo, paths, goal, branch?, session?, ttl_minutes?}` | Takes a claim (default 60 min, max 240) and returns the brief; `GET /v1/claims`, `POST /v1/claims/:id/renew`, `DELETE /v1/claims/:id` |
| `POST /v1/poll`, `GET /v1/status` | Polls now; the last poll's report |
| `POST /mcp` | The MCP server (Streamable HTTP, stateless): `brief`, `claim`, `renew_claim`, `release_claim`, `check`, `in_flight` |

Claude Code reaches it with a Cloudflare Access service token:
`claude-code/mcp.example.json` (the MCP server over HTTP) and
`claude-code/settings.example.json` with `claude-code/hooks/lockkeeper.mjs`
(the brief at session start, the check before `git commit` and `git push`).
Set `LOCKKEEPER_URL`, `LOCKKEEPER_ACCESS_CLIENT_ID`,
`LOCKKEEPER_ACCESS_CLIENT_SECRET` and `LOCKKEEPER_HOOK` (the hook's path);
without them the hook says nothing and exits 0.

Where no shell loaded those variables, as in a Claude desktop-app session,
`claude-code/mcp-stdio.mjs` is a stdio MCP server that forwards to `/mcp`:
register it as a stdio server through a wrapper that runs it under
`direnv exec <workspace>`, and the token is read from the workspace `.envrc`
at start instead of being written into a settings file. The same wrapper can
run the hooks.

```bash
# once, from the Mac (the founder): the GitHub App, then
wrangler d1 create lockkeeper-cofferdam          # paste the id into wrangler.cofferdam.jsonc
wrangler vectorize create lockkeeper-cofferdam --dimensions=1024 --metric=cosine
wrangler vectorize create-metadata-index lockkeeper-cofferdam --property-name=repo --type=string
pnpm --filter worker db:migrate:cofferdam
wrangler secret put GITHUB_APP_PRIVATE_KEY -c worker/wrangler.cofferdam.jsonc < app-key.pem
pnpm deploy:cofferdam
# local: pnpm --filter worker dev:cofferdam (Access skipped with ENVIRONMENT=development)
```

Tests: `pnpm --filter worker test` runs them in the Workers pool against
Miniflare's D1 with a faked GitHub and a faked Access team, with no secret.

## The demo

`DEMO.md` is the runbook: four goals on the sample project, two of them
on the same route file, one held for review, a fifth to show the brief
at work, with the shot list and the narration. The sample project is a
small Hono Worker with a vitest suite in `sample-api/`. The public
deployment answers at `lockkeeper-demo.cofferdam.xyz`, behind its token.

## Roadmap

In the order it will be built.

1. **Claims before commits.** The files an agent reads or opens draw
   scaffolding on the floor in its colour, so two agents heading for the
   same file is visible before either has committed. The brief then
   carries the claims as well as the commits. (The Cofferdam deployment
   has claims over GitHub since 2026-10-22; the demo's map does not yet.)
2. **The map at scale.** Level of detail for repositories with hundreds
   of files, a label budget, and three canonical cameras: perspective,
   straight down for collisions, side-on for sequence.
3. **Agents ask the lock.** A tool the agent can call before it edits:
   who is on this file, what merged since my base, what the lock would
   decide. The same questions the map answers, in the agent's loop. (Built
   for the Cofferdam deployment as its MCP server, without the lock's
   decision, which is step 3 of `DESIGN.md` §13.)
4. **Change sets across dependent repositories.** One goal that spans
   repositories spawns a task per repository, the downstream sandbox
   installs the upstream fork as a dependency through the gateway's
   grants, and the lock holds a change until its upstream siblings
   land.
5. **Pull-request mode.** The merge sandbox pushes the decided change to
   GitHub and opens a pull request carrying Clef's verdicts, for
   organisations where GitHub stays the system of record; `main` mirrors
   back.
6. **Operations.** Cloudflare Access in front of the dashboard so every
   approval carries an identity, a cap on concurrent agents and on spend
   per task, prompt destruction of idle sandboxes and deletion of
   abandoned forks, policies on regions of the code that always require
   review.

Status: the loop runs end to end, October 2026.
