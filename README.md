# Lockkeeper

Many coding agents, one repository. A visual coding agent in the spirit
of GitHub Copilot's, running entirely on Cloudflare. Each agent works in its own
[Artifacts](https://developers.cloudflare.com/artifacts/) fork; a
[Vectorize](https://developers.cloudflare.com/vectorize/) index tells each
agent what the others are doing before it starts; a Workflow asks
[Clef](https://developers.cloudflare.com/workers-ai/models/clef/), Cloudflare's
calibrated decision model, which change should merge next, whether it may
merge without a human, and how much risk it carries for the work in flight.
Merges happen one at a time in a dedicated sandbox with real git and the
project's tests. A 3D dashboard shows the repository, the agents and the
merges live.

Built on Cloudflare Workers, Artifacts, Containers, Workers AI, Vectorize,
D1, Queues, Workflows, AI Gateway and Workers Builds. `DESIGN.md` explains
how it works. MIT licensed; see `LICENSE`.

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
its provider keys; the sandboxes never see that key.

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

A human can also work a task: `POST /api/tasks/manual` returns a fork and a
one-hour write token; push, then `POST /api/tasks/:id/submit` and the change
enters the merge round like an agent's.

## The dashboard

Open the Worker URL. The page asks for the dashboard token once and keeps
it in the browser; `?token=…` in the URL also works and is stripped on
load. The shape is the one coding-agent apps made familiar: a sidebar
with the project and its sessions, a home screen with the prompt box
(one line per agent, auto merge or hold for review), the project bar and
an on-your-radar list, a session view with the agent's stream beside
map, diff and decision tabs, and a work list. The Map view is the live
visualisation of Artifacts: a three.js scene with `main` as the innermost
ring and every branch as an arc on a concentric ring outside it, angle as
time, commits as beads, spokes where a branch leaves and rejoins `main`,
agents riding the tip of their live arc, and files on a quiet layer below
that light up for whatever you select. Click a point to open the file, the
commit or the agent's session. The timeline at the bottom replays a run.
⌘K opens the command palette. `GET /api/state`,
`GET /api/tasks/:id/events` and `GET /api/history` are everything the
page renders.

To preview the built dashboard locally against a deployed Lockkeeper
without putting the token in a browser:

```sh
pnpm --filter dashboard build
node dashboard/dev-proxy.mjs --upstream https://<worker>.workers.dev --token-file ./secrets.env --port 8788
```

Status: under construction (October 2026).
