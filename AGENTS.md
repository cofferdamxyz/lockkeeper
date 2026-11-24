# AGENTS Instructions — Lockkeeper

Lockkeeper tells every session working on an organisation's repositories
what else is in flight and advises in which order the open pull requests
should land. It reads GitHub and never acts on it. `DESIGN.md` is the
source of truth for behaviour; `README.md` for running it. Change the
design document in the same commit as the behaviour it describes.

## What it may do

It polls GitHub through Lockkeeper's own GitHub App, keeps the index,
claims and Clef's advice on the open pull requests (the landing order and
one comment per pull request), and serves an HTTP API and an MCP server
behind Cloudflare Access (Cofferdam workspace decisions 0053 and 0092).

It never runs an agent and never merges, opens, labels or closes
anything. It writes to GitHub only its installation token request and the
advice comment (`writeComment` in `github.ts`, called from `advice.ts`
alone), and `worker/wrangler.jsonc` binds no container, Artifacts,
Workflow, queue, Durable Object, assets or service.
`worker/test/guard.test.ts` enforces both; widening either is a decision
in the workspace log first (decision 0088's reporter is the one planned,
`DESIGN.md` §13).

The repository once held a second thing, the Artifacts competition
runner with its dashboard. It was removed on 2026-11-23 and lives at the
tag `competition-runner-final`. Do not bring any of it back.

## Layout

- `worker/` — the Lockkeeper Worker (Hono), deployed with Wrangler.
  `src/index.ts` is the routes and the cron; `config.ts` the
  configuration's keys and defaults; `github.ts` the GitHub App client;
  `poll.ts` the poller; `ci.ts` the state of CI on a head, from check
  runs or the CI comment; `claims.ts`; `inflight.ts` the in-flight
  answer, the brief and the check; `advice.ts` the advising pass;
  `issues.ts` the issue binding; `present.ts` the one-read answer for the
  OS gatekeeper; `monitor.ts` the page for a person at `/` (text only, no
  script; `monitorFonts.ts` is its two fonts, generated); `access.ts` Access verification; `mcp.ts` the MCP
  server; `store.ts` D1; `vectorIndex.ts` and `vectors.ts` the index;
  `clef.ts` Clef's shapes; `paths.ts` globs and the sensitive list. D1
  migrations are `worker/migrations/`.
- `claude-code/` — the hook script, a stdio MCP proxy (`mcp-stdio.mjs`,
  for sessions whose environment did not load the `.envrc`) and example
  settings and MCP config through which Claude Code sessions read
  Lockkeeper.
- `docs/diagrams/` — the README's four diagrams, as rendered PNGs. They
  are copies: the source is `social/diagrams/lockkeeper/render.py` in
  `cofferdam-branding`, which draws them from the brand tokens with the
  builder of the XMTP article. Never edit a PNG here; when a fact a
  diagram states changes in `DESIGN.md` (the poll's five minutes, the
  cosine of 0.6, the comment's wording), change the script, render and
  copy the four files over.
- `lockkeeper.config.ts` — the organisation's values and nothing else:
  owner, excluded repositories, the sensitive-path list, the CI sources,
  how a branch names its issue, and whatever differs from the defaults
  in `worker/src/config.ts`. Secrets never live here.

## Conventions

- Package manager: pnpm (workspace at the root). Never `npm install`.
- No organisation in the source. `lockkeeper.config.ts` and
  `worker/wrangler.jsonc` hold Cofferdam's values (test fixtures and
  `.github/workflows/ci.yml` carry its name as data); a new
  organisation-specific value becomes a key in `worker/src/config.ts`
  with a default, never a literal. The same holds for hosts in
  `claude-code/`: no default URL. `worker/test/guard.test.ts` fails
  otherwise.
- Tests in the Workers pool read the fixture
  `worker/src/test/lockkeeper.config.fixture.ts`, never the root
  configuration; a test that needs other settings passes them.
- Names: in flight, claim, brief, check, candidate, landing order,
  unattended-eligible, decision (`DESIGN.md` §1). Lockkeeper advises; it
  is never said to lock, merge or queue anything.
- The Worker, D1 and Vectorize are named `lockkeeper-cofferdam`: they are
  Cofferdam's deployed resources, and a rename would be a new Worker.
- Secrets go through `wrangler secret put` in `worker/`: only
  `GITHUB_APP_PRIVATE_KEY`. An Access service token lives with the client
  that uses it, never in the Worker.
- Applied migrations are never edited, comments included.
- Tests: `pnpm test` (the Workers pool over Miniflare for everything
  under `worker/src/`, with a faked GitHub and a faked Access team and no
  secrets; plain vitest for the guard in `worker/test/`, which reads the
  source with `node:fs`; `node --test` for the hook). Types: `pnpm check`.
  Deploys are the founder's, from the Mac (`pnpm run deploy`; a bare
  `pnpm deploy` is pnpm's own command).
- Review: `REVIEW.md` says what failure looks like here.
- Commits are signed off (`git commit -s`) with
  `Co-Authored-By: Claude <model> <noreply@anthropic.com>` naming the model
  that wrote the change, when Claude wrote it.
