# AGENTS Instructions — Lockkeeper

Lockkeeper lets many coding agents work on one repository at once and
decides, change by change, what merges into `main`. `DESIGN.md` is the
source of truth for behaviour; `README.md` for running it. Change the
design document in the same commit as the behaviour it describes.

## Layout

- `worker/` — the Lockkeeper Worker (Hono): API, task ledger (D1), the
  agent sandbox Durable Object, the outbound gateway, the merge Workflow,
  the queue consumer, Clef and Vectorize clients. Deploys with Wrangler.
- `dashboard/` — Next.js static export with React Three Fiber; `out/` is
  served by the Worker as static assets. `lib/city.ts` is the map's layout
  (pure, tested); `components/City.tsx` only draws it.
- `sample-api/` — the demo project agents work on: a small Hono Worker
  with a vitest suite, pushed to the project repository in Artifacts.
- `lockkeeper.config.ts` — the per-organisation configuration (projects,
  merge mode, thresholds, allowlist). Secrets never live here.

## Conventions

- Package manager: pnpm (workspace at the root). Never `npm install`.
- Cloudflare names only: fork, agent, sandbox, index, merge Workflow,
  merge sandbox, decision, decision log, dashboard. The lock is the
  product name and, in the dashboard, the merge queue itself (the chamber
  on the column and the lock panel).
- Secrets go through `wrangler secret put` on `worker/`:
  `AI_GATEWAY_TOKEN`, `DASHBOARD_TOKEN`, optional `GITHUB_DEPLOY_KEY`.
- Agent sandboxes start with `enableInternet: false`; every outbound request
  passes through `worker/src/outbound.ts`, which allows three hosts and
  injects the gateway token. Artifacts tokens are held by the Worker, never
  passed to an agent process.
- Tests: `pnpm test` (vitest with the Workers pool in `worker/`, plain
  vitest in `sample-api/`). Types: `pnpm check`.
- Commits are signed off (`git commit -s`) with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` when Claude
  wrote the change.
