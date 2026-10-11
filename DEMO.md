# The demo

A five-to-ten-minute recording of Lockkeeper running four agents on
`sample-api` at once. The repository already carries a day of merged
work, so the city has strata before the first agent starts, which is
the point: the demo shows the code changing in time, not an empty floor.

## Before recording

- Nothing in flight: the lock pill reads "empty" on the Map. Hold or
  abandon anything that is not.
- The agent image is built and the deployment answers `/health`.
- Browser window at 1440×900 or wider, dark scheme, sidebar expanded.
- Window control on the Map set to **auto**; the last session should
  fill the column with the quiet gap folded above it.
- Open two tabs: Home and Map. The session view opens on demand.

## The goal set

Home → "Run the demo set" fills the composer with four goals. The first
two touch `src/routes/vessels.ts` and `test/routes.test.ts`; the lock
has to order them and one of them will conflict and be resolved. The
third and fourth are isolated and merge unattended.

1. `Add GET /vessels/:id/visits returning the berths a vessel has moored at, newest first, with tests`
2. `Add DELETE /vessels/:id that removes a vessel and frees its berth, 404 when unknown, with tests`
3. `Add a request id middleware that sets an X-Request-Id header on every response, with tests`
4. `Add GET /stats/vessels summarising vessels moored and at sea, with tests`

Launch 1–3 with **Auto merge**. Launch 4 on its own with **Hold for
review** (⇧Tab), so one change waits for a person and the approval shows
on camera. A fifth goal, launched after the first merges land, shows the
brief at work:

5. `Add Cache-Control headers to the stats endpoints, with tests`

Its session view, "What the agent was told", names the stats change
that just merged.

Agents take four to eight minutes each at about ten cents a run.

## Shots, in order

1. **Home.** The fleet summary reads "all quiet". Paste the four goals;
   the chip under the composer counts four agents. Point at the two
   decisions above the box: from `main` at its sha, auto merge.
2. **Launch.** Toasts announce four agents. Switch to the Map.
3. **Beacons.** Four beacons rise over the files the agents are reading;
   the first edits pulse. Within a minute the first plates land on the
   floor's files and threads begin: a branch growing live.
4. **Overlap.** The red halo on `src/routes/vessels.ts` with "overlap ·
   2 agents". Click the file: the panel names both agents and says the
   lock will order them.
5. **The lock.** The first ready change appears as a disc under the now
   ring and in the lock panel at the bottom right with Clef's unattended
   score. Click the disc: the task card, its commits in order.
6. **A merge lands.** The white ring on the column, spokes to the files,
   the stack turning settled. Click the ring: the decision panel with
   the gauges against the thresholds and the candidates it was weighed
   against.
7. **The conflict.** The second vessels change conflicts with `main`;
   the toast says the resolver is on it; its thread holds. When it
   lands, the double ring. Open its session: the resolver's note under
   the outcome.
8. **The held change.** The fourth goal reaches the lock amber, "waits
   for you". Open its session: the facts, the brief, the steps paired
   with their outputs, the commits. Approve. The blue ring lands.
9. **The fifth goal.** Launch it; open its session; fold open "What the
   agent was told". It names the merged stats change.
10. **Replay.** Drag the now ring down the column: the beacons vanish,
    the stacks shrink, the rings disappear in reverse. Release at the
    top: live again.
11. **Close on the city at rest**, the session folded into the column
    with the quiet gap above it, and the sentence: every element on this
    map is a question an operator has or a command that changes what
    the lock does.

## Narration points

- GitHub's unit of attention is the pull request; with a fork per task
  and agents producing commits faster than anyone reads them, the unit
  has to move to the region of code and to the lock that orders what
  lands.
- Everything runs on Cloudflare: Artifacts for forks and tokens,
  Containers for sandboxes, Workers AI for Clef and embeddings,
  Vectorize for the index, D1 for the ledger, Queues for pushes,
  Workflows for the merge loop, AI Gateway for the model key, a Durable
  Object for the live feed.
- The sandboxes never hold a credential: the outbound gateway injects
  the fork token and the model key per request.
- Clef is calibrated: the unattended threshold is a number you set, and
  the resolver's work raises it.

## After recording

Nothing to reset. The merged work stays as history, which is what the
next viewer should see. If a run went wrong on camera, abandon the task
from its session; its fork is deleted and its plates fade.
