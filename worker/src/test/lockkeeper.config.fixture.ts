// The configuration every test in the Workers pool runs against (`vitest.config.ts` resolves
// `lockkeeper.config` to this file), so that editing the real `lockkeeper.config.ts` for an
// organisation never breaks a test. It is a frozen copy of one organisation's values, kept as
// test data: the names below are fixtures, not a deployment. CI is read from the comment here;
// the tests of check runs pass their own settings.
import { defineConfig } from "../config";

export type { CiSource, LockkeeperConfig } from "../config";

export default defineConfig({
  owner: "cofferdamxyz",
  exclude: ["cofferdam-prover"],
  sensitive: [
    "cofferdam-api/src/env.ts",
    "cofferdam-api/src/services/sessionAttestation.ts",
    "cofferdam-api/src/services/authorityCheck.ts",
    "cofferdam-api/src/services/ceremony.ts",
    "cofferdam-api/src/services/selfBind.ts",
    "cofferdam-api/src/services/userOp.ts",
    "cofferdam-api/src/services/relaySend.ts",
    "cofferdam-api/src/routes/ceremony.ts",
    "cofferdam-api/src/routes/session.ts",
    "cofferdam-api/src/routes/aa.ts",
    "cofferdam-api/src/routes/self.ts",
    "cofferdam-attester/**",
    "cofferdam-app/src/lib/passkey.ts",
    "cofferdam-app/src/lib/recoveryPhrase.ts",
    "cofferdam-app/src/lib/wallet.ts",
    "base-contracts/**",
    "**/wrangler.jsonc",
    "**/.github/workflows/**",
    "cofferdam-os/deployment.jsonc",
    "cofferdam-os/scripts/**",
    "lockkeeper/worker/src/**",
    "lockkeeper/lockkeeper.config.ts",
  ],
  ci: { sources: ["comment"], commentMarker: "<!-- cofferdam-ci:" },
  issues: { repo: "cofferdam", branch: "^claude/(\\d+)-" },
});
