# REVIEW.md — lockkeeper

Read with `AGENTS.md` and `DESIGN.md`. Here failure means **it acts where it should only advise, answers a caller it should have refused, or says something false about what is in flight**.

## What failure looks like

- A write to GitHub other than the installation token request and the advice comment: a merge, a pull request opened or closed, a label, a review, a push, an issue. The guard test (`worker/test/guard.test.ts`) reads how a write is spelled, not what the code does, so read `github.ts` and every caller of `writeComment` yourself. A new writer is a workspace decision first (0088's reporter is the one planned).
- `worker/wrangler.jsonc` gaining a container, Workflow, queue, Durable Object, assets or service binding, `workers_dev` or `preview_urls` on, a hardcoded `account_id`, a secret value, or a changed `name`, D1 or Vectorize name (the deployed resources are `lockkeeper-cofferdam`; a rename is a new Worker).
- A route reachable without `verifyAccess`, other than `GET /health`; Access skipped outside `ENVIRONMENT=development`; an empty `ACCESS_AUD` that does not refuse; a claim renewed or released by an identity that did not take it.
- The App's private key, an installation token, an Access assertion or a service-token secret logged, returned in an error, or present in a config, a test or a doc.
- Text a pull request chooses for itself (file names, titles, commit messages, branch names) reaching Clef's state or the advice comment uncut or unescaped: it must not crowd out other candidates, close a code span or write a line of its own.
- A candidate read as unattended-eligible while it touches a sensitive path, has no green CI on its head, shares a file with another open pull request, sits on a stale or unknown base, or has no answer from Clef. A change that shortens `sensitive` in `lockkeeper.config.ts` or loosens `clef.unattended` or `clef.maxRisk`.
- A refused or failed GitHub or Workers AI call read as an empty result: no branches, no collisions, "nothing moved".
- The hook (`claude-code/hooks/lockkeeper.mjs`) blocking anything but the one colliding push, exiting non-zero when unconfigured or unreachable, or running after a push. A token written into a settings file.
- An applied migration edited, or a new one that drops `decisions` or `outcomes` (the calibration record).
- A behaviour change without `DESIGN.md` in the same commit, or a docs claim in the workspace (`docs/runbooks/cloudflare-deploys.md`, `development-setup.md`) that the change made false.

## Skip

- `pnpm-lock.yaml` churn with no package change; `worker/worker-configuration.d.ts` (generated, not tracked).

## How to report

- Every finding names a file and line and quotes the code or text that is wrong. A guess from a name or a path is not a finding.
- Tag each one **Important** (wrong behaviour, a broken rule above, a security or money risk), **Nit** (at most three per review; style alone is never one) or **Pre-existing** (true, but not introduced by this diff; never blamed on it).
- Flag a class of bug once with every instance, not one finding per line. Do not repeat a finding already answered in an earlier round; after the second round read only the new diff.
- Start the summary with the count ("2 Important, 1 Nit, 1 Pre-existing"), and say "Nothing to fix" plainly when that is the result.
- Name the risk tier the diff falls in (workspace `docs/runbooks/code-review.md`).
