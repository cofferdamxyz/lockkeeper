# Lockkeeper

Many coding agents, one repository. Each agent works in its own
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
pnpm exec wrangler d1 migrations apply lockkeeper --remote
cd .. && pnpm deploy                                # builds the dashboard, deploys the Worker
cd worker
pnpm exec wrangler secret put DASHBOARD_TOKEN       # any long random string
pnpm exec wrangler secret put AI_GATEWAY_TOKEN      # the authenticated-gateway token
```

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

Open the Worker URL for the dashboard; `GET /api/state` is what it renders.

Status: under construction (October 2026).
