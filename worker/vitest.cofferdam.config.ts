import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The advisory deployment, inside workerd through Miniflare: D1 is local, GitHub and Access are
// faked per test, Workers AI and Vectorize are left out so overlap runs by path (no secrets).
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations-cofferdam"));
  return {
    plugins: [
      cloudflareTest({
        main: "./src/advise/index.ts",
        miniflare: {
          // The pool's workerd (miniflare 5.20260815) stops at 2026-08-22; the deployment pins 2026-09-15.
          compatibilityDate: "2026-08-22",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: "test",
            GITHUB_APP_ID: "12345",
            ACCESS_TEAM_DOMAIN: "https://cofferdam.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            GITHUB_APP_PRIVATE_KEY: "",
          },
        },
      }),
    ],
    test: {
      include: ["src/advise/**/*.test.ts"],
      setupFiles: ["./src/advise/test/setup.ts"],
    },
  };
});
