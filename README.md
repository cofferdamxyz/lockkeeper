<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/lockkeeper-lockup-horizontal-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/logo/lockkeeper-lockup-horizontal-black.svg">
    <img alt="Lockkeeper" src="docs/logo/lockkeeper-lockup-horizontal-black.svg" width="300">
  </picture>
</h1>

Lockkeeper tells everyone working on your repositories, people and coding
agents alike, what else is being worked on right now, before two of them
change the same file. It also reads your open pull requests and advises
in which order they should land.

It watches GitHub and answers questions. It never runs an agent and
never merges, and the service itself blocks nothing: the one thing it
writes is an advice comment on a pull request.

![Lockkeeper at a glance: sessions ask Lockkeeper through Cloudflare Access; Lockkeeper polls GitHub every five minutes and keeps a ledger in D1, vectors in Vectorize and two models on Workers AI; its only write to GitHub is one advice comment; a git push goes straight to GitHub, never through Lockkeeper.](docs/diagrams/01-at-a-glance.png)

It is one Cloudflare Worker with D1, Vectorize and Workers AI, behind
Cloudflare Access, that you host in your own account. MIT licensed.

## Why you would want it

Coding agents produce branches faster than anyone can read them. Picture
an ordinary afternoon:

- Two sessions start from the same `main`. Both edit `src/routes/export.ts`.
- Neither knows about the other. GitHub shows a branch only once it is
  pushed, and a conflict only once a pull request exists.
- They find out at push time, which is when a rebase costs the most: the
  work is done, the tests passed, and now it has to be redone on top of
  someone else's change.
- Meanwhile six pull requests are open. Nobody can say which one should
  land first, or which of them would break the others.

Lockkeeper fills that gap with facts a session can read at four moments:

| When | What you ask | What you get back |
|---|---|---|
| Before you start | "What is in flight near these paths?" | A **brief**: the branches, pull requests and claims near your work, what landed recently, and which of your paths are sensitive |
| Before a branch exists | "I am about to work here" | A **claim** with a time to live, so the first hour of work is visible to everyone else too |
| Before a commit or a push | "What moved under me?" | A **check**, read live from GitHub: what `main` gained since your base, and which of those files you also changed |
| Before anything lands | "What should land next?" | **Advice**: the order to land the open pull requests in, and for each one whether it could land without a person and how risky it is to the others |

A brief is plain text, written for an agent or a person to read:

```text
Lockkeeper: acme/api (main at 9ab12cd, read 2 min ago)
In flight near your work:
- claim "Stream the export instead of buffering": claimed by sam@acme.dev, expires in 42 min, on `src/routes/export.ts`; shares `src/routes/export.ts`
- branch `export-queue`: PR #41 "Move the export to a queue", CI pass, 3 ahead, 0 behind, last commit 3 h ago by dana; shares `src/routes/export.ts`
4 other changes in flight elsewhere in the repository.
Landed on main recently (2 files):
- 9ab12cd export: cap the page size
Awareness, not a lock: main always wins and branches rebase onto it; nothing here stops you.
```

That last line is the whole principle. Lockkeeper is **awareness, not a
lock**: `main` always wins, branches rebase onto it, and a claim says who
is about to work somewhere, never that anyone else may not. If Lockkeeper
is down, every session works exactly as it did without it.

## How it works

### One session, start to landing

![One session from start to landing, in seven steps across three lanes (Session, Lockkeeper, GitHub): the session asks for a brief, takes a claim, and asks for a check before a commit or a push; Lockkeeper reads GitHub live for that check; the session pushes and opens a pull request, straight on GitHub; the next poll sees the branch and releases its claim; Lockkeeper writes one advice comment on the pull request.](docs/diagrams/02-one-session.png)

Every arrow into Lockkeeper is a question, and every answer is a fact to
read. The push itself goes from the session to GitHub and never passes
through Lockkeeper, which holds no credential that could change your
code: its GitHub App reads code and cannot push or merge. Its
pull-request permission is used for the advice comment alone, and a test
in this repository fails if the source ever spells another write.

### How it knows what is in flight

![How Lockkeeper knows what is in flight, in three rows. The poll, every five minutes with no webhook: list the repositories the GitHub App can see, compare a branch again when it or main moved, record files, merge base, ahead, behind and CI, embed one vector per branch. A claim, for the hour before a branch exists: take it with paths, a goal and a time to live; it shows in every brief that touches those paths; it is released once its branch is on GitHub or it expires. A question: match by shared path, match by meaning (a cosine of 0.6 or more) when the question states a goal, list what is near, count the rest.](docs/diagrams/03-in-flight.png)

- **The poll.** A cron reads GitHub every five minutes through
  Lockkeeper's own GitHub App. There is no webhook and no route outside
  Access. A branch is compared again only when it or `main` moved; open
  pull requests and their CI are read on every poll.
- **Claims.** A branch is invisible until it is pushed. A claim covers
  that window: paths, a one-line goal and a time to live (an hour by
  default, four at most). A claim that names its branch is released when
  that branch reaches GitHub; any other claim expires, or you release it.
- **Two ways to be near.** Work is near yours when it shares a file,
  folder or glob with you. It is also near when it reads alike: each
  branch and claim is embedded with bge-m3, so when your question states
  a goal, two changes to the same feature are found even when they share
  no path yet. A claim always carries a goal; the hooks send paths only.

### From open pull requests to advice

![From open pull requests to advice. Candidates are the open pull requests from the repository's own branches, drafts included, twenty at most. Clef answers three questions: which lands next, may it land without a person, how much risk to the others. Rules can only say no: CI not green, a sensitive path, a file shared with another pull request, a stale base. The result is the landing order and one comment per pull request, created once and edited in place; the comment is Lockkeeper's only write to GitHub.](docs/diagrams/04-advice.png)

After each poll, for every repository whose pull requests moved,
Lockkeeper takes the open pull requests from the repository's own
branches (drafts included, twenty at most) and asks [Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
Cloudflare's calibrated decision model, three questions: which pull
request should land next, whether each could land without a person, and
how much risk each carries for the others. Then its own rules apply, and
they can only say no. A pull request is never "eligible to land
unattended" if CI is not green on its head, it touches a path on your
sensitive list, it shares a file with another open pull request, or
`main` changed one of its files after its base.

The result is one comment per pull request, edited in place as things
change:

> ### Lockkeeper advice · `4b5909a`
>
> **Landing order:** 2 of 5 open pull requests in this repository (after #41).
>
> **Unattended-eligible:** no. Shares files with #41 (`src/routes/export.ts`). Clef's unattended 0.62 is under 0.80.
>
> **Risk to the other changes in flight:** minor risk (1.00 of 3). Clef: unattended 0.62, next 0.31.
>
> <sub>Advice only: Lockkeeper lands nothing and applies no label. It rewrites this comment when the head, CI or the other open pull requests change.</sub>

"Eligible" is a verdict to read. Nothing lands on its own; a person
still decides.

## Use it from your tools

Every client reaches Lockkeeper the same way: over HTTPS, with a
Cloudflare Access service token in two headers. The hook and the proxy
refuse any other scheme (plain http works on the loopback address only)
and never follow a redirect, so the token goes to the host you named and
nowhere else. Give each client its own
token, and set these three variables wherever the client runs:

```sh
export LOCKKEEPER_URL=https://lockkeeper.example.com
export LOCKKEEPER_ACCESS_CLIENT_ID=<the service token's client id>
export LOCKKEEPER_ACCESS_CLIENT_SECRET=<the service token's client secret>
```

### Claude Code

Two pieces, both in `claude-code/`. Use either or both.

**The MCP server** gives a session seven tools: `brief`, `claim`,
`renew_claim`, `release_claim`, `check`, `in_flight` and `landing_order`.
Copy `claude-code/mcp.example.json` into your project's `.mcp.json`.

**The hooks** make it automatic, so no one has to remember to ask. Copy
`claude-code/settings.example.json` into `.claude/settings.json`, and
export a fourth variable, `LOCKKEEPER_HOOK`, with the absolute path of
`claude-code/hooks/lockkeeper.mjs` (one Node script, no dependencies):

- At session start, the session reads the brief for its repository.
- Before `git commit` and `git push`, it reads the check.
- If a push would collide with what just landed on `main`, the hook holds
  that push once and says why, so the session rebases first. The same
  push goes through the second time. `LOCKKEEPER_PUSH=inform` turns the
  hold off.

Without those variables the hook says nothing and exits 0, and each
request gives up after four seconds if Lockkeeper is slow. It can never
be the reason a session is stuck.

Where no shell loaded those variables, as in a Claude desktop-app
session, register `claude-code/mcp-stdio.mjs` instead: a stdio MCP server
that forwards to `/mcp`. Run it through a wrapper such as
`direnv exec <workspace> node claude-code/mcp-stdio.mjs`, and the token
is read from your `.envrc` at start instead of being written into a
settings file. The same wrapper can run the hooks.

### Any other agent, script or CI job

It is a small HTTP API. Ask for a brief before starting:

```sh
curl -s "$LOCKKEEPER_URL/v1/brief?repo=api&paths=src/routes/export.ts,src/lib/&goal=stream+the+export" \
  -H "CF-Access-Client-Id: $LOCKKEEPER_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $LOCKKEEPER_ACCESS_CLIENT_SECRET"
```

Take a claim once you know where you will work. The answer includes the
brief, and naming the branch you will push lets the claim end on its own
when that branch reaches GitHub:

```sh
curl -s -X POST "$LOCKKEEPER_URL/v1/claims" \
  -H "CF-Access-Client-Id: $LOCKKEEPER_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $LOCKKEEPER_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"repo":"api","paths":["src/routes/export.ts"],"goal":"Stream the export instead of buffering","branch":"export-stream","session":"nightly refactor bot","ttl_minutes":90}'
```

Check before a commit or a push, with your merge base and the files you
changed:

```sh
curl -s -X POST "$LOCKKEEPER_URL/v1/check" \
  -H "CF-Access-Client-Id: $LOCKKEEPER_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $LOCKKEEPER_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"repo\":\"api\",\"base\":\"$(git merge-base HEAD origin/main)\",\"paths\":[\"src/routes/export.ts\"],\"branch\":\"export-stream\"}"
```

The answer's `text` is ready to show to a model or a person;
`collisions` lists the files that moved under you. A repository is named
`owner/name` or just `name`, and paths may be files, folders (`src/lib/`)
or globs (`src/lib/**`).

### A person, in a browser

Open the deployment's address and sign in through Access. The root is a
monitor: the landing queue per repository with each pull request's CI,
verdict and Clef's numbers, the branches in flight and what they share,
the claims, what landed in the last day, and Clef's decisions with what
became of its advice. It reloads every minute and has no control on it;
`?repo=<name>` shows one repository.

### A tracker, a dashboard or a bot

`GET /v1/present` is one read with everything a board needs: the branches
in flight with their pull request, CI and overlaps, the live claims and
the landing order. `GET /v1/advice` is the landing order alone. Any MCP
client can use the same seven tools at `POST /mcp` (Streamable HTTP,
stateless).

### The whole API

| Route | What it answers |
|---|---|
| `GET /v1/brief?repo=&paths=&goal=&branch=` | The brief, as text: in flight near these paths, what landed recently, sensitive paths |
| `GET /v1/inflight?…` | The same as JSON |
| `POST /v1/check` `{repo, base, paths, branch?, goal?}` | Before a commit or push: what moved on the default branch since `base` (read live), which files collide, other work on them |
| `POST /v1/claims` `{repo, goal, paths?, branch?, session?, ttl_minutes?}` | Takes a claim (default 60 min, max 240, at most 50 live per identity; without paths it covers the repository) and returns the brief; `GET /v1/claims`, `POST /v1/claims/:id/renew`, `DELETE /v1/claims/:id` |
| `POST /v1/poll`, `GET /v1/status` | Polls now (and asks for check runs again if GitHub had refused them); the last poll's and the last advising pass's reports |
| `GET /v1/advice?repo=` | The landing order per repository: each open pull request's position, CI, unattended-eligible verdict with its reasons, Clef's numbers, label suggestion and issue |
| `GET /v1/present?repo=` | One read for a tracker: branches in flight with pull request, CI, issue and overlap on each other, live claims, the landing order |
| `POST /v1/advise` | Runs the advising pass now (`?force=1` asks Clef again where nothing moved) |
| `POST /mcp` | The MCP server: `brief`, `claim`, `renew_claim`, `release_claim`, `check`, `in_flight`, `landing_order` |
| `GET /` | The monitor: one page for a person, with the queue, the branches in flight and Clef's decisions |
| `GET /health` | Alive, and when the last poll ran; the one route the Worker answers without checking the Access assertion again |

## Run your own

You need a Cloudflare account with Workers, D1, Vectorize, Workers AI and
Zero Trust (Access); a GitHub organisation; Node 24 and pnpm.

1. **A GitHub App** on the organisation: webhook off; repository
   permissions Metadata read, Contents read, Checks read, Pull requests
   read and write; installed on the repositories Lockkeeper should watch. Note the App ID
   and generate a private key.
2. **An Access application** (self-hosted) on the hostname, with a policy
   for the people who may ask and a Service Auth policy for the service
   tokens your clients use. Note the application's AUD tag.
3. **Make it yours.** Two files name an organisation, and no source
   file does. Before you create anything:
   - **`worker/wrangler.jsonc`** carries Cofferdam's names, ids and
     hostname. Change `name`, `routes`, the D1 and Vectorize names,
     `GITHUB_APP_ID`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Without
     `ACCESS_AUD` every request is refused.
   - **`lockkeeper.config.ts`** holds Cofferdam's values. Replace its
     contents with yours; the smallest one is

     ```ts
     import { defineConfig } from "./worker/src/config";
     export type { CiSource, LockkeeperConfig } from "./worker/src/config";
     export default defineConfig({ owner: "your-org" });
     ```

     Everything else has a default (`worker/src/config.ts` lists them).
     The one worth setting early is `sensitive`: globs, `<repo>/<path>`,
     a change may never touch and still be called unattended-eligible.
     The default is every CI workflow; add your auth code and your
     deploy config, and keep `**/.github/workflows/**` in the list.
4. **The resources and the deploy**, from the repository root:

```sh
pnpm install
cd worker
pnpm exec wrangler d1 create lockkeeper-cofferdam          # your name; paste the id into wrangler.jsonc
pnpm exec wrangler vectorize create lockkeeper-cofferdam --dimensions=1024 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index lockkeeper-cofferdam --property-name=repo --type=string
pnpm db:migrate
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < app-key.pem
pnpm run deploy
```

5. **CI: name your job.** Lockkeeper reads the check runs on each pull
   request's head, which is what GitHub Actions and most CI apps already
   write. A head is green when none of its runs failed or is still
   running and at least one succeeded. Set
   `ci: { requireChecks: ["test"] }` to the name of your CI job (`*`
   matches any run of characters): then a head your CI never ran on is
   not green just because a deploy app or a scanner reported success. If
   a check that is not required keeps failing, name it in
   `ci.ignoreChecks`.

   If your App cannot have Checks read, set
   `ci: { sources: ["comment"] }` and have each CI job keep one comment
   on the pull request: a first line `<!-- lockkeeper-ci:<job> -->`,
   then a heading ``### CI ✅ passed · `<job>` on <sha7>`` (or
   `❌ failed`), where `<sha7>` is the first seven characters of the head
   commit, posted by a bot and updated in place.
   `.github/workflows/ci.yml` in this repository has a step that writes
   one (with Cofferdam's marker). If you name both sources, both must
   say passed. When GitHub refuses check runs, `GET /v1/status` says so
   under `notes` instead of passing it off as a repository without CI.

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
requests, apply labels, or block a push. The one place a push is ever
held is the Claude Code hook, once, on the session's own machine, and
one variable turns that off. The repository's guard test fails if the Worker ever binds something that
could act, or spells a write to GitHub other than its token request and
the advice comment.

## More

- `DESIGN.md` is the full design: every rule of the advising pass, what
  is stored and for how long, how identity works.
- `AGENTS.md` and `REVIEW.md` are for people and agents changing this
  repository.
- The diagrams are drawn from Cofferdam's brand tokens; their source is
  in the brand repository, and `docs/diagrams/` holds the rendered
  copies.

## History

Lockkeeper began in October 2026 as an entry for Cloudflare's Artifacts
competition: a runner that gave each agent its own Artifacts fork and
sandbox, merged through a Clef-ordered Workflow, and drew the work as a
3D map. That code was removed on 2026-11-23; the tag
`competition-runner-final` is its last commit, with its own README and
design document.
