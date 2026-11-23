import { defineConfig } from "vitest/config";

// `test/` holds checks over the source and the Wrangler config themselves (node:fs), so they run
// under plain vitest, outside workerd and outside the Worker type check. Everything else runs in
// the Workers pool: `vitest.config.ts`.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
