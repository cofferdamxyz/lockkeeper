import { defineConfig } from "vitest/config";

// Pure modules (Clef request builder, projection, overlap) run under plain vitest.
// Durable Object containers need a deployed Worker; they are not unit-tested here. `test/` holds
// checks over the source itself (node:fs), outside the Worker type check.
// The advisory deployment's tests run in the Workers pool: `vitest.cofferdam.config.ts`.
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], exclude: ["src/advise/**"] },
});
