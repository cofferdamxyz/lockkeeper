# Lockkeeper

## 1. What it is

Lockkeeper tells every person and every coding agent working on an
organisation's repositories what else is in flight, before they collide,
and advises in which order the open pull requests should land. It reads
GitHub; it never runs an agent, merges, opens, labels or closes anything.
Its one write to a repository is an advice comment on a pull request.

It answers four questions:

- **What is in flight near these paths?** Branches ahead of the default
  branch, open pull requests, and claims by sessions that have not pushed
  yet, with what landed recently and which of the paths are sensitive.
- **What moved under me?** Before a commit or a push: what the default
  branch gained since the asker's merge base, which of those files the
  asker also changed, and who else is on them.
- **What should land next?** Clef, Cloudflare's calibrated decision model,
  over the open pull requests of a repository: which lands next, may it
  land without a person, how much risk it carries for the others.
- **What is the present state?** One read for a tracker: branches, pull
  requests, CI, issues, overlaps, claims and the landing order.

The name is the one metaphor: a canal lock moves boats between water
levels one chamber at a time, and the lockkeeper sets the order. Here the
lockkeeper watches the water and calls the order; a person works the
gates.

| Term | Meaning here |
|---|---|
| in flight | A branch ahead of its default branch, an open pull request, or a live claim |
| claim | "I am about to work on these paths", with a time to live, for the window before a branch is pushed |
| brief | The in-flight answer as text, for a session to read at its start |
| check | The answer before a commit or push, read live from GitHub |
| candidate | An open pull request (drafts included) the advising pass ranks |
| landing order | The order in which a repository's candidates should land |
| unattended-eligible | A verdict that a candidate could land without review; nothing lands unattended |
| decision | One request to Clef and its answer, kept in the ledger |

## 2. The principle

Awareness, not a lock. Main always wins, branches always rebase, every
push asks first. A claim, a brief or a landing order is a fact a session
reads; none of them stops anyone. Every answer ends on that sentence, and
a session whose Lockkeeper is unreachable works exactly as it did without
it.

The same holds for the advice. Clef's verdict is a comment to read and a
number to calibrate. The person who lands branches decides, and the
record of what they actually landed is what the thresholds are later
checked against.

Lockkeeper holds no credential that could change a repository's code:
its GitHub App has metadata and contents read and pull-request write, and
the Worker binds no container, Workflow, queue, Durable Object or
service. `worker/test/guard.test.ts` fails if the Wrangler config binds
one or if the source spells a write to GitHub other than the token
request and the advice comment. The guard is a tripwire, not a proof, so
`worker/src/**` and `lockkeeper.config.ts` are on the sensitive list.

## 3. Components

| Component | Cloudflare primitive | Role |
|---|---|---|
| Worker | Worker (Hono), `worker/src/index.ts` | The HTTP API, the MCP server, the cron |
| Poller | Cron trigger, every five minutes | Reads GitHub through the App, under a D1 lease |
| Ledger | D1 | Repositories, branches, default-branch moves, claims, advice, decisions, outcomes |
| Index | Vectorize (1024 dimensions, cosine) + Workers AI `@cf/baai/bge-m3` | One vector per branch in flight and per claim; similarity where no path is shared |
| Clef | Workers AI `@cf/cloudflare/clef` | `choice` (next), `noul` (may it land unattended), `score` (risk to the others) |
| Access | Cloudflare Access in front of the hostname | Who may ask; the Worker verifies the assertion again |
| GitHub App | Lockkeeper's own App on the organisation | Reads; writes the advice comment |
| Claude Code pieces | `claude-code/` | The hooks and the stdio MCP proxy a session runs |

Bindings: `DB` (D1), `VECTORIZE`, `AI`. Vars: `ENVIRONMENT`,
`GITHUB_APP_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`. Secret:
`GITHUB_APP_PRIVATE_KEY`. Without `AI` or `VECTORIZE` overlap runs by path
only and the advising pass orders by its rules; nothing else changes.

## 4. The poller and the index

A cron every five minutes, under a D1 lease so a manual `POST /v1/poll`
never overlaps it. There is no webhook: no public ingress and no webhook
secret.

It lists the repositories the installation can see (the installation's
repository selection is the scope; `exclude` drops some, archived ones
are skipped), then per repository the open pull requests. When the
repository's `pushed_at` moved, it reads the branch list, one compare per
branch whose head moved (files, ahead, behind, merge base, commit first
lines) and one compare when the default branch moved, recorded in
`main_moves` for "landed recently".

CI comes from the one comment per job that Cofferdam CI keeps on each
pull request (`<!-- cofferdam-ci:<job> -->`), because the App reads no
check runs: `pass` when every job reported on the head, `fail` when one
failed, `pending` while one still names an older head. The poller never
reads Lockkeeper's own comment as a CI report.

A branch is embedded when its head moves, from its repository, name, pull
request title, last commit first lines and files. Deleted or fully merged
branches leave the index. A branch without a commit for `staleDays` (14)
and no pull request drops out of "in flight". The index is derived:
everything in it can be rebuilt from GitHub and D1.

## 5. Claims

A claim covers the window before a branch exists on GitHub:
`{repo, paths, goal, branch?, session?}` with a time to live (60 minutes
by default, 240 at most). It is owned by the Access identity that took it
(only that identity renews or releases it), embedded like a branch,
released when its branch reaches GitHub, and pruned a day after it ends.
Paths may be files, directories (`src/lib/`) or globs (`src/lib/**`); a
claim without paths covers the repository. Taking a claim returns the
brief for its paths.

A claim's label is free text a session gives itself. It says who is
about to work somewhere, never that anyone else may not.

## 6. The answer

**In flight and the brief.** For a repository and a path set: every
branch, pull request and claim that shares a path (glob-aware), or whose
cosine against the query's text reaches `nearCosine` (0.6), with the
Jaccard of the path sets beside it; the rest is counted, not listed. Plus
what landed in the last `recentHours` (24) and which of the paths are on
the sensitive list. `GET /v1/inflight` is the JSON, `GET /v1/brief` the
same as text.

**The check.** Before a commit or a push the answer reads GitHub live:
one compare from the asker's merge base to the default branch, because
the base is the asker's and the poll may be five minutes old. It reports
what moved, which of those files the asker also changed, and other work
in flight on them.

**The landing order.** `GET /v1/advice?repo=` and the MCP tool
`landing_order`: per repository, each candidate's position, CI, verdict
with its reasons, Clef's numbers, label suggestion and issue (§7).

**The present state.** `GET /v1/present?repo=`: per repository the
branches in flight with their pull request, CI, issue and the files each
shares with the others, the live claims and the landing order, in one
read. It is what a tracker draws; the Cofferdam OS gatekeeper over
Lockkeeper (`packages/lockkeeper-gatekeeper` in `cofferdam-os`,
read-only, with its own Access service token) reads it for the
Development Tracker's Present column.

| Route | What it answers |
|---|---|
| `GET /health` | Alive, and when the last poll ran. The one route the Worker answers without verifying the Access assertion again; Access still sits in front of it |
| `GET /v1/brief?repo=&paths=&goal=&branch=` | The brief, as text |
| `GET /v1/inflight?…` | The same as JSON |
| `POST /v1/check` `{repo, base, paths, branch}` | What moved since `base`, the collisions, other work on those files |
| `POST /v1/claims` `{repo, paths, goal, branch?, session?, ttl_minutes?}` | Takes a claim and returns the brief; `GET /v1/claims`, `POST /v1/claims/:id/renew`, `DELETE /v1/claims/:id` |
| `POST /v1/poll`, `GET /v1/status` | Polls now; the last poll's and the last advising pass's reports |
| `GET /v1/advice?repo=` | The landing order per repository |
| `GET /v1/present?repo=` | Branches, overlaps, claims and the landing order in one read |
| `POST /v1/advise` | Runs the advising pass now (`?force=1` asks Clef again where nothing moved) |
| `POST /mcp` | The MCP server (§9) |

## 7. The advising pass

`worker/src/advice.ts`, run by the cron right after the poll, one request
to Clef per repository.

- *Candidates.* Per repository, the branches with an open pull request,
  drafts included (delegated branches stay drafts until they land), oldest
  first, at most `clef.maxCandidates` (20); past that the newest wait for
  a later round, without advice. Each carries its overlap with every other
  candidate (shared files, Jaccard of the path sets, cosine of the bge-m3
  vectors when Workers AI is bound) and the files the default branch
  changed after its base.
- *The question.* Three, over pull requests: `next` (a choice, when there
  are two or more), and per candidate `unattended` (a noul) and `risk` (a
  score on four levels). The state names CI, the commits ahead and behind,
  the sensitive paths, the issue and the last five moves of the default
  branch. Everything a pull request chooses for itself (file names,
  titles, commit messages) is cut to length, file names are reduced to a
  plain path alphabet, and the state is bounded at 150,000 characters. A
  repository is asked again only when its candidates moved (a head, CI, a
  title, the default branch, a pull request opened or closed), and nothing
  is embedded or asked before that check; after a failed or partial answer
  it is asked again no sooner than thirty minutes later, and the order
  from the rules stands meanwhile.
- *The verdict.* The landing order is Clef's pick, then its
  probabilities; what it did not rank follows the rules (green CI, least
  overlap, oldest). A candidate is unattended-eligible only when nothing
  below holds: it touches a sensitive path (which also suggests the
  `security` label); CI did not pass on its head; it shares a file with
  another open pull request; the default branch changed one of its files
  after its base, or it is behind from a base older than the record of the
  default branch's moves (fourteen days, twenty moves), so what changed
  under it is not known; Clef's `unattended` is under `clef.unattended`
  (0.80) or its `risk` over `clef.maxRisk` (1.0); Clef gave no answer.
  Eligible is a verdict to read: nothing lands unattended.
- *The comment.* One per candidate, marked `<!-- lockkeeper-advice -->`:
  the head it speaks for, the position, the verdict with every reason,
  Clef's numbers, the label suggestion and the issue. It carries no
  timestamp, so it is created once and edited in place only when its text
  changes (written anew if someone deleted it); at most 40 writes a pass.
  File names appear in it only through the same plain alphabet, so a name
  cannot close its code span or write a line of its own. These two calls
  (`writeComment` in `github.ts`, called from `advice.ts` alone) are the
  only writes to GitHub besides the token request. A refusal (the App
  without pull-request write) pauses comments for `advice.retryHours` (6);
  the advice is kept either way, and `advice.comment: false` turns
  comments off.
- *The issue.* A branch named `claude/<issue>-<slug>`, as Cofferdam's
  dispatch routine pushes it, is bound to that issue in `issues.repo`
  (`cofferdam`) by its name alone: in the comment, the brief, the
  in-flight answer and the landing order. Whoever can push a branch
  chooses that name, so the binding says which issue a branch claims, not
  that the issue asked for it.
- *The ledger and calibration.* Every request and answer is a row in
  `decisions` (kept 90 days). When a candidate leaves, `outcomes` records
  what the advice said (position, how many were open, Clef's numbers, the
  verdict) and whether the pull request landed, was closed, or is gone
  from GitHub (`unknown`): the record against which the thresholds are
  later checked. A pull request that cannot be read for a passing reason
  is read again on the next pass.

## 8. Access and identity

**Who may ask.** The hostname sits behind Cloudflare Access, and the
Worker verifies `Cf-Access-Jwt-Assertion` again against the team's keys,
the application's audience (var `ACCESS_AUD`) and the issuer. A person is
named by email, a service token by `service:<client id>`. Without
`ACCESS_AUD` every request is refused, except under
`ENVIRONMENT=development` for `wrangler dev`. `workers_dev` is off: a
workers.dev URL would skip Access.

**Who Lockkeeper is on GitHub.** Its own GitHub App, never another bot's
token. The App's numeric id is the var `GITHUB_APP_ID`, its private key
the secret `GITHUB_APP_PRIVATE_KEY`, in GitHub's own PKCS#1 form (the
Worker wraps it into PKCS#8 for WebCrypto). The Worker signs a
nine-minute App JWT, finds the installation on the organisation, and
mints an installation token, held in memory until five minutes before it
expires. Permissions: metadata read, contents read, pull requests read
and write (for the advice comment). No webhook.

**Secrets.** `GITHUB_APP_PRIVATE_KEY` through `wrangler secret put`,
nothing else. An Access service token lives with the client that uses it
(a Claude Code session, a bot, the OS gatekeeper), never in the Worker.

## 9. Clients

### The MCP server

`POST /mcp`, Streamable HTTP without sessions or a server stream, JSON
responses: `brief`, `claim`, `renew_claim`, `release_claim`, `check`,
`in_flight`, `landing_order`. A tool that fails answers as text with
`isError`, so a session carries on without Lockkeeper.

### The stdio proxy

`claude-code/mcp-stdio.mjs`, one Node script with no dependencies: a
stdio MCP server that POSTs each JSON-RPC line to `/mcp` with the
service-token headers from its environment and writes the answer back (a
notification's 202 produces nothing). It exists because a Claude
desktop-app session has no shell that loaded the workspace `.envrc`, so
an HTTP MCP entry with `${VAR}` headers would send empty headers there;
run under `direnv exec <workspace>`, the proxy reads the token at start
and nothing secret is written into a settings file.

### The hooks

`claude-code/hooks/lockkeeper.mjs`, one Node script with no dependencies.
On `SessionStart` it prints the brief for the repository (or, in a cloud
session that starts above the clones, for each clone with something to
say), with the changed paths of the current branch. On `PreToolUse` for
Bash, before `git commit` and `git push`, it computes the merge base and
changed paths locally, asks `/v1/check` and adds the answer to the
context.

It blocks in one case only, because that context reaches the model next
to the tool's result, after the push already ran: a push whose files
collide with what landed on the default branch is held once with the
reason, so the session rebases first, and the same push goes through the
second time (`LOCKKEEPER_PUSH=inform` turns the hold off). Unconfigured,
unreachable or slow (four seconds), it exits 0 with nothing. Nothing runs
after a push. Example settings and MCP config sit beside it.

### Other readers

Anything with an Access service token of its own reads the same routes.
At Cofferdam: the Engineering and Security bots (`coworkers`) read the
landing order, and the OS gatekeeper reads the present state (§6).

## 10. Storage

D1, migrations in `worker/migrations/`. Everything is rebuildable from
GitHub except claims, which live for hours, and the decision ledger and
outcomes, which are the calibration record.

| Table | Holds | Kept |
|---|---|---|
| `repos` | One row per repository the App can see: default branch, head, last push and poll | While the App sees it |
| `branches` | The work in flight: head, merge base, ahead and behind, files, commit first lines, pull request, CI, sensitive paths | Until deleted or merged |
| `main_moves` | What moved into a default branch, poll to poll | Fourteen days (a read takes the newest twenty) |
| `claims` | Paths, goal, owner, session label, branch, expiry | A day after it ends |
| `advice` | The advice in force per candidate: position, Clef's numbers, verdict, reasons, the comment's body and id | Rebuilt when candidates move |
| `decisions` | Every request to Clef with its answer or error | 90 days |
| `outcomes` | What the advice said when a candidate left, and what happened to it | Kept |
| `settings` | The poll lease, the last reports, per-repository fingerprints | — |

Vectorize holds one vector per branch (`b:<hash>`, since branch names
outgrow the 64-byte id) and per claim (`c:<id>`), with `repo`, `kind` and
`name` as metadata; `repo` has a metadata index.

## 11. Configuration

`lockkeeper.config.ts` at the repository root, typed and non-secret:

- `owner` and `exclude`: the organisation the App is installed on, and
  repositories the index skips;
- `sensitive`: globs, `<repo>/<path>`, a change may never touch and still
  be unattended-eligible. Cofferdam's list names the plane's session
  attestation, authority checks, ceremonies, passport binding, user
  operations, relay and `env.ts`, with their routes; the whole attester;
  the app's passkey, recovery phrase and wallet modules;
  `base-contracts/**`; every `wrangler.jsonc`; the OS `deployment.jsonc`
  and `scripts/**`; every `.github/workflows/**`, because CI is the
  evidence and a change to it must never go unattended; and Lockkeeper's
  own `worker/src/**` and this file;
- `staleDays`, `claims` (default and maximum minutes), `nearCosine`,
  `recentHours`;
- `advice`: whether the advice is commented, and how long to wait after a
  refusal;
- `issues`: the repository that holds the issues and the pattern by which
  a branch names one;
- `clef`: the model (`clef` or `clef-flash`), the `unattended` and
  `maxRisk` thresholds, `maxCandidates`.

## 12. Deployment

Self-hosted, one deployment per organisation, inside that organisation's
own Cloudflare account. The index, the ledger and the App's key never
leave the account, and Cloudflare Access decides who may ask. It is not a
multi-tenant service.

Cofferdam's deployment is the Worker `lockkeeper-cofferdam` at
`lockkeeper.cofferdam.xyz`, behind the Access team
`cofferdam.cloudflareaccess.com`, with D1 and Vectorize of the same name
and the GitHub App `cofferdam-lockkeeper` installed on `cofferdamxyz`.
The names carry `-cofferdam` because a demo Worker held the plain name
when it was first deployed (§14); a rename would be a new Worker. Deploys
are the founder's, from the Mac; the record is in the Cofferdam workspace,
`docs/runbooks/cloudflare-deploys.md`.

Another organisation deploys it by creating its own GitHub App and Access
application, a D1 database and a Vectorize index, editing
`worker/wrangler.jsonc` (names, ids, hostname, `GITHUB_APP_ID`,
`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) and `lockkeeper.config.ts`, setting
the one secret and running `pnpm run deploy`. `README.md` has the commands.

## 13. Planned

Nothing in this section is built.

- **The mobile reporter** (Cofferdam workspace decision 0088, accepted
  2026-11-20). Lockkeeper files failed builds and submissions, TestFlight
  feedback and crashes as deduplicated issues on `cofferdam-app`. It adds
  the first write beyond the advice comment (issues and their comments on
  that one repository; the App gains `issues: write`), the first route
  outside Access (`POST /v1/expo/webhook`, answering only a body signed
  with the Expo webhook secret) and read-only credentials for App Store
  Connect and the Play Developer Reporting API, polled by the cron. The
  guard test admits one more writer when it is built.
- **A claude.ai connector** for people's own agents, with Access as the
  OIDC provider in front of the same MCP server. It waits until a second
  person asks.
- **Calibration.** The `outcomes` table is filled; nothing reads it yet.
  Checking the thresholds against what was actually landed is the step
  that could later let an eligible pull request land without a person,
  under a decision of its own.

## 14. Where it came from

Lockkeeper began in October 2026 as an entry for Cloudflare's Artifacts
competition (Cofferdam workspace decisions 0008 and 0011): a runner that
gave each coding agent its own Artifacts fork and container sandbox,
merged their changes one at a time through a Workflow that asked Clef,
and showed the work as a three-dimensional map. Cofferdam's own
development never ran on it: Claude Code sessions and routines over
GitHub did that job, and what Cofferdam needed from Lockkeeper was the
part GitHub lacks, which is this service (decision 0053, 2026-10-22). The
two lived in one repository until the runner, the dashboard and the
sample project were removed on 2026-11-23 (decision 0092).

The runner is in git history. The tag `competition-runner-final` is its
last commit, with its own `DESIGN.md`, `README.md` and `DEMO.md`. What
this service kept from it: the Clef request shape and the tolerant
reading of its answers, the overlap pair (cosine and Jaccard of paths),
the bge-m3 index and the decision ledger.

## 15. Risks and unknowns

- Clef starts uncalibrated here. Conservative thresholds and the fact
  that nothing lands unattended cover that until outcomes accumulate.
- CI is read from a comment convention, not from check runs. A repository
  whose CI does not keep the `cofferdam-ci` comment reads as `none`, and
  its pull requests are never eligible.
- The poll is up to five minutes old. The check before a push reads
  GitHub live for that reason; the brief does not.
- Vectorize upserts are visible after seconds, not instantly; a claim
  taken and queried at once is found by its paths, not yet by similarity.
- The guard test reads how a write is spelled, not what the code does.
  Review reads every change to `worker/src/**`.

## Change log

- 2026-11-23: the competition runner removed (Cofferdam workspace
  decision 0092): the agent sandbox, the Artifacts forks, the outbound
  gateway, the merge Workflow and its sandbox, the queue consumer, the
  dashboard and its map, `sample-api/` and `DEMO.md`. The service moved
  from `worker/src/advise/` to `worker/src/`, its Wrangler config from
  `wrangler.cofferdam.jsonc` to `wrangler.jsonc`, its migrations from
  `migrations-cofferdam/` to `migrations/`, and its scripts lost their
  `:cofferdam` suffix (`pnpm run deploy`, `pnpm db:migrate`). The
  configuration is flat (no `advise` key, no projects, no agent settings).
  `GET /health` no longer answers `deployment: "advise"`. `worker/src/**`
  and `lockkeeper.config.ts` joined the sensitive list, which this
  document had claimed and the configuration had not held. This document
  was rewritten around the service; its earlier form is at the tag
  `competition-runner-final`. The deployed Worker, D1 and Vectorize are
  unchanged and keep their names.

- 2026-11-13: the advising pass deployed with comments on (Worker version
  `42c2f6e4`).

- 2026-11-11: the advising pass built (§7): Clef's three questions over
  the open pull requests of a repository after each poll, the landing
  order, the unattended-eligible verdict with its reasons, one comment per
  candidate pull request edited in place, the issue bound by the branch
  name, the decision ledger and the outcomes table, `GET /v1/advice` and
  the MCP tool `landing_order`. The fixtures' commit dates became
  relative: three tests had started failing once the fixed October dates
  aged past `staleDays`. The same day, `GET /v1/present` for the OS
  gatekeeper.

- 2026-10-22: the service built and first deployed (Cofferdam workspace
  decision 0053): the GitHub App client, the poller, claims, the brief and
  the check, Access verification, the MCP server, the stdio proxy and the
  Claude Code hook.
