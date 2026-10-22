# AGENTS Instructions — Lockkeeper

Lockkeeper lets many coding agents work on one repository at once and
decides, change by change, what merges into `main`. `DESIGN.md` is the
source of truth for behaviour; `README.md` for running it; `DEMO.md` for
the recorded demo. Change the design document in the same commit as the
behaviour it describes.

## Deployments

The demo (`lockkeeper-demo.cofferdam.xyz`, `worker/wrangler.jsonc`) runs
everything below. The Cofferdam deployment (`lockkeeper.cofferdam.xyz`,
`worker/wrangler.cofferdam.jsonc`, entry `worker/src/advise/index.ts`) is
advice only (Cofferdam workspace decision 0053, accepted 2026-10-22;
`DESIGN.md` §12–§13): it polls GitHub through Lockkeeper's own GitHub App,
keeps the index, claims and (later) Clef's advice, and serves an HTTP API
and an MCP server behind Cloudflare Access. It never runs the sandbox, the
outbound gateway, the merge sandbox or the dashboard. Code under
`worker/src/advise/` must not import the runner (sandbox, Artifacts,
outbound, Workflow, tasks, queue) and must not write to GitHub beyond
minting its installation token until step 3 adds comments;
`worker/test/advise-guard.test.ts` enforces both.

## Layout

- `worker/` — the Lockkeeper Worker (Hono): API, task ledger (D1), the
  agent sandbox Durable Object, the outbound gateway, the merge Workflow,
  the queue consumer, Clef and Vectorize clients. Deploys with Wrangler.
- `dashboard/` — Next.js static export with React Three Fiber; `out/` is
  served by the Worker as static assets. `lib/city.ts` is the map's layout
  (pure, tested); `components/City.tsx` only draws it.
- `sample-api/` — the demo project agents work on: a small Hono Worker
  with a vitest suite, pushed to the project repository in Artifacts.
- `worker/src/advise/` — the Cofferdam advisory deployment: the GitHub App
  client, the poller, claims, the in-flight answer and the brief, Access
  verification, the MCP server. Its D1 migrations are
  `worker/migrations-cofferdam/`.
- `claude-code/` — the hook script, a stdio MCP proxy (`mcp-stdio.mjs`,
  for sessions whose environment did not load the `.envrc`) and example
  settings and MCP config through which Claude Code sessions read the
  Cofferdam deployment.
- `lockkeeper.config.ts` — the per-organisation configuration (projects,
  merge mode, thresholds, allowlist, and `advise` for the Cofferdam
  deployment: owner, excluded repositories, the sensitive-path list,
  claim times). Secrets never live here.

## Conventions

- Package manager: pnpm (workspace at the root). Never `npm install`.
- Cloudflare names only: fork, agent, sandbox, index, merge Workflow,
  merge sandbox, decision, decision log, dashboard. The lock is the
  product name and, in the dashboard, the merge queue itself (the chamber
  on the column and the lock panel).
- Secrets go through `wrangler secret put` on `worker/`:
  `AI_GATEWAY_TOKEN`, `DASHBOARD_TOKEN`, optional `GITHUB_DEPLOY_KEY`; for
  the Cofferdam deployment (`-c wrangler.cofferdam.jsonc`) only
  `GITHUB_APP_PRIVATE_KEY`. The Access service token lives with the
  Claude Code sessions that use it, never in the Worker.
- Agent sandboxes start with `enableInternet: false`; every outbound request
  passes through `worker/src/outbound.ts`, which allows three hosts and
  injects the gateway token. Artifacts tokens are held by the Worker, never
  passed to an agent process.
- Tests: `pnpm test` (plain vitest for the demo's pure modules and the
  guard, the Workers pool over Miniflare for the Cofferdam deployment
  (`worker/vitest.cofferdam.config.ts`, faked GitHub and Access, no
  secrets), plain vitest in `sample-api/`, `node --test` for the hook).
  Types: `pnpm check`. Deploys are the founder's, from the Mac.
- Commits are signed off (`git commit -s`) with
  `Co-Authored-By: Claude <model> <noreply@anthropic.com>` naming the model
  that wrote the change, when Claude wrote it.
