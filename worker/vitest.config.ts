import { defineConfig } from "vitest/config";

// Pure modules (Clef request builder, projection, overlap) run under plain vitest.
// Durable Object containers need a deployed Worker; they are not unit-tested here.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
