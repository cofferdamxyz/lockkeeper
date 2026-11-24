// Your organisation's Lockkeeper configuration: non-secret, one deployment per organisation.
// This file and `worker/wrangler.jsonc` are the two places that name an organisation; the keys
// and their defaults are in `worker/src/config.ts`. Secrets go through `wrangler secret put`
// (DESIGN.md, "Access and identity").
//
// Running your own: replace everything below with your `owner` and whatever differs from the
// defaults. The smallest configuration is `export default defineConfig({ owner: "your-org" })`.
import { defineConfig } from "./worker/src/config";

export type { CiSource, LockkeeperConfig } from "./worker/src/config";

// Cofferdam's deployment (workspace decisions 0053 and 0095).
//
// The sensitive list names the real paths (corrected 2026-10-22: the decision's
// `cofferdam-api/src/auth/**` matched nothing): the plane's session attestation, authority
// checks, ceremonies, Self binding, user operations and relay; the whole attester; the app's
// passkey, recovery phrase and wallet; the contracts; every Worker config and the OS deployment
// and deploy script; every CI workflow, because CI is the evidence and a change to it must never
// go unattended; and Lockkeeper's own source and this file, because the guard test over its
// GitHub writes is a tripwire, not a proof.
//
// CI: both sources, and both must say passed. The comment each repository's CI job keeps on its
// pull request (`<!-- cofferdam-ci:<job> -->`) is what says the CI itself ran on the head, which
// is why no check is required by name (the jobs are named differently per repository); the check
// runs add every other check on it. Until the App holds Checks read GitHub refuses them and the
// comment alone answers.
//
// Issues: the dispatch routine pushes `claude/<issue>-<slug>`, and the issues live in `cofferdam`.
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
  ci: { sources: ["checks", "comment"], commentMarker: "<!-- cofferdam-ci:" },
  issues: { repo: "cofferdam", branch: "^claude/(\\d+)-" },
});
