# AGENTS Instructions — harbor-api

A small Hono Worker: berths and the vessels moored at them. Several agents
change this repository at the same time; keep changes small and local.

- TypeScript, Hono 4. Routes live in `src/index.ts`; split into
  `src/routes/*.ts` only when a goal asks for it.
- Tests use vitest with Hono's `app.request()` and live in `test/`. Run
  `npm test`. Every behaviour change comes with a test.
- Do not add dependencies unless the goal requires them.
- Commit as you go with messages that state the intent.
