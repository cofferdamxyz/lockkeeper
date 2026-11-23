# Lockkeeper

Awareness and landing advice for repositories many agents work on at
once. Lockkeeper reads an organisation's repositories on GitHub and tells
every session, person or coding agent, what else is in flight near its
work before it collides, and in which order the open pull requests should
land. It never runs an agent and never merges: its one write to a
repository is an advice comment on a pull request.

It is one Cloudflare Worker with D1, Vectorize and Workers AI, behind
Cloudflare Access, self-hosted in your own account. `DESIGN.md` explains
how it works. MIT licensed; see `LICENSE`.

## Why

Coding agents produce branches faster than anyone reads them. Two
sessions start from the same `main`, change the same file, and find out
at push time, when a rebase costs the most. GitHub shows a branch only
once it is pushed and a conflict only once a pull request exists.

Lockkeeper fills that gap with facts a session can read:

- **Before work starts**, a brief: the branches, pull requests and claims
  near these paths, what landed recently, which paths are sensitive.
- **Before a branch exists**, a claim: "I am about to work here", with a
  time to live, so the first hour of work is visible too.
- **Before a commit or a push**, a check read live from GitHub: what
  moved on the default branch since your base, and which of those files
  you also changed.
- **Before anything lands**, advice: [Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
  Cloudflare's calibrated decision model, ranks a repository's open pull
  requests, says which could land without a person and how risky each is
  to the others, and Lockkeeper writes that as one comment per pull
  request.

The principle is awareness, not a lock. Main always wins, branches
rebase, and nothing here stops anyone; a session whose Lockkeeper is
unreachable works as it did without it.

## How it works

1. A cron polls GitHub every five minutes through Lockkeeper's own GitHub
   App: repositories, branches, open pull requests, changed paths, and CI
   as reported in pull request comments. No webhook, no public ingress.
2. Each branch in flight and each claim is embedded with bge-m3 into
   Vectorize, so work with no shared path can still be found near.
3. After each poll the advising pass asks Clef three questions over the
   candidates of every repository that moved, applies its rules (CI,
   sensitive paths, shared files, a stale base), and keeps the landing
   order and one comment per pull request, edited in place.
4. Sessions read it over HTTP or MCP, behind Cloudflare Access.

## The API

| Route | What it answers |
|---|---|
| `GET /v1/brief?repo=&paths=&goal=&branch=` | The brief, as text: in flight near these paths, what landed recently, sensitive paths |
| `GET /v1/inflight?…` | The same as JSON |
| `POST /v1/check` `{repo, base, paths, branch}` | Before a commit or push: what moved on the default branch since `base` (read live), which files collide, other work on them |
| `POST /v1/claims` `{repo, paths, goal, branch?, session?, ttl_minutes?}` | Takes a claim (default 60 min, max 240) and returns the brief; `GET /v1/claims`, `POST /v1/claims/:id/renew`, `DELETE /v1/claims/:id` |
| `POST /v1/poll`, `GET /v1/status` | Polls now; the last poll's and the last advising pass's reports |
| `GET /v1/advice?repo=` | The landing order per repository: each open pull request's position, CI, unattended-eligible verdict with its reasons, Clef's numbers, label suggestion and issue |
| `GET /v1/present?repo=` | One read for a tracker: branches in flight with pull request, CI, issue and overlap on each other, live claims, the landing order |
| `POST /v1/advise` | Runs the advising pass now (`?force=1` asks Clef again where nothing moved) |
| `POST /mcp` | The MCP server (Streamable HTTP, stateless): `brief`, `claim`, `renew_claim`, `release_claim`, `check`, `in_flight`, `landing_order` |
| `GET /health` | Alive, and when the last poll ran; the one route the Worker answers without checking the Access assertion again |

## Claude Code

A session reaches Lockkeeper with a Cloudflare Access service token:
`claude-code/mcp.example.json` (the MCP server over HTTP) and
`claude-code/settings.example.json` with `claude-code/hooks/lockkeeper.mjs`
(the brief at session start, the check before `git commit` and `git push`).
Set `LOCKKEEPER_URL`, `LOCKKEEPER_ACCESS_CLIENT_ID`,
`LOCKKEEPER_ACCESS_CLIENT_SECRET` and `LOCKKEEPER_HOOK` (the hook's path);
without them the hook says nothing and exits 0.

The hook holds a push once when its files collide with what landed on
the default branch, so the session rebases first; the same push goes
through the second time, and `LOCKKEEPER_PUSH=inform` turns the hold off.

Where no shell loaded those variables, as in a Claude desktop-app session,
`claude-code/mcp-stdio.mjs` is a stdio MCP server that forwards to `/mcp`:
register it as a stdio server through a wrapper that runs it under
`direnv exec <workspace>`, and the token is read from the workspace `.envrc`
at start instead of being written into a settings file. The same wrapper can
run the hooks.

## Run it

Requirements: a Cloudflare account with Workers, D1, Vectorize, Workers AI
and Zero Trust (Access); a GitHub organisation; Node 24 and pnpm.

1. **A GitHub App** on the organisation: webhook off; repository
   permissions Metadata read, Contents read, Pull requests read and write;
   installed on the repositories Lockkeeper should watch. Note the App ID
   and generate a private key.
2. **An Access application** (self-hosted) on the hostname, with a policy
   for the people who may ask and a Service Auth policy for a service
   token. Note the application's AUD tag.
3. **The resources and the deploy**, from `worker/`:

```sh
pnpm install
cd worker
pnpm exec wrangler d1 create lockkeeper-cofferdam          # paste the id into wrangler.jsonc
pnpm exec wrangler vectorize create lockkeeper-cofferdam --dimensions=1024 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index lockkeeper-cofferdam --property-name=repo --type=string
pnpm db:migrate
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < app-key.pem
pnpm run deploy
```

`worker/wrangler.jsonc` carries Cofferdam's names, ids and hostname:
change `name`, `routes`, the D1 and Vectorize names, `GITHUB_APP_ID`,
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` to yours (and the database name in
`worker/package.json`'s `db:migrate`). `lockkeeper.config.ts` holds the
organisation, the sensitive-path list and Clef's thresholds. Without
`ACCESS_AUD` every request is refused.

Locally, `pnpm dev` runs the Worker with `ENVIRONMENT=development` and
the cron reachable for testing. Access is skipped only when `ACCESS_AUD`
is empty as well, so set `ACCESS_AUD=` in `worker/.dev.vars`; with the
value from `wrangler.jsonc` every route but `/health` still asks for an
Access assertion.

Tests: `pnpm test` runs them in the Workers pool against Miniflare's D1
with a faked GitHub and a faked Access team, with no secret. Types:
`pnpm check`.

## What it will not do

It does not run agents, hold a merge queue, merge, open or close pull
requests, apply labels, or block a push on its own authority. "Eligible to
land unattended" is a verdict to read. The repository's guard test fails
if the Worker ever binds something that could act, or spells a write to
GitHub other than its token request and the advice comment.

## History

Lockkeeper began in October 2026 as an entry for Cloudflare's Artifacts
competition: a runner that gave each agent its own Artifacts fork and
sandbox, merged through a Clef-ordered Workflow, and drew the work as a
3D map. That code was removed on 2026-11-23; the tag
`competition-runner-final` is its last commit, with its own README and
design document.
