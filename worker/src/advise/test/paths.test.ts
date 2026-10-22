import { describe, expect, it } from "vitest";

import { cleanPaths, entriesOverlap, globToRegExp, sensitiveHits, sharedPaths } from "../paths";
import config from "../../../../lockkeeper.config";

describe("globs", () => {
  it("keeps * inside a segment and lets ** cross segments", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/lib/a.ts")).toBe(false);
    expect(globToRegExp("src/**").test("src/lib/a.ts")).toBe(true);
    expect(globToRegExp("**/wrangler.jsonc").test("wrangler.jsonc")).toBe(true);
    expect(globToRegExp("**/wrangler.jsonc").test("xmtp/push-relay/wrangler.jsonc")).toBe(true);
    expect(globToRegExp("src/lib/").test("src/lib/deep/x.ts")).toBe(true);
  });

  it("finds overlap between files, directories and globs", () => {
    expect(entriesOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(entriesOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(entriesOverlap("src/lib/**", "src/lib/x.ts")).toBe(true);
    expect(entriesOverlap("src/", "src/lib/**")).toBe(true);
    expect(entriesOverlap("src/app/**", "src/lib/**")).toBe(false);
    expect(sharedPaths(["src/a.ts", "README.md"], ["src/**"])).toEqual(["src/a.ts"]);
  });
});

describe("the sensitive-path list (decision 0053)", () => {
  const s = config.advise.sensitive;
  it("marks the real paths in their repositories only", () => {
    expect(sensitiveHits("cofferdamxyz/cofferdam-api", ["src/services/sessionAttestation.ts", "src/routes/chat.ts"], s)).toEqual(["src/services/sessionAttestation.ts"]);
    expect(sensitiveHits("cofferdamxyz/cofferdam-api", ["src/routes/session.ts", "src/env.ts", "src/services/chatUsageStore.ts"], s)).toEqual(["src/routes/session.ts", "src/env.ts"]);
    expect(sensitiveHits("cofferdamxyz/cofferdam-app", ["src/lib/passkey.ts", "src/lib/chats.ts"], s)).toEqual(["src/lib/passkey.ts"]);
    expect(sensitiveHits("cofferdamxyz/cofferdam-attester", ["src/celoGate.ts"], s)).toEqual(["src/celoGate.ts"]);
    expect(sensitiveHits("cofferdamxyz/base-contracts", ["contracts/account/A.sol"], s)).toEqual(["contracts/account/A.sol"]);
    expect(sensitiveHits("cofferdamxyz/cofferdam-api", ["xmtp/cleanup/wrangler.jsonc", "wrangler.jsonc"], s)).toHaveLength(2);
    expect(sensitiveHits("cofferdamxyz/cofferdam-sdk", [".github/workflows/ci.yml", "packages/core/src/index.ts"], s)).toEqual([".github/workflows/ci.yml"]);
    expect(sensitiveHits("cofferdamxyz/cofferdam-os", ["deployment.jsonc", "scripts/deploy.ts", "context/x.md"], s)).toEqual(["deployment.jsonc", "scripts/deploy.ts"]);
  });
});

describe("cleanPaths", () => {
  it("trims, drops traversal and duplicates", () => {
    expect(cleanPaths(["./src/a.ts", "/src/a.ts", "", " b ", "../etc/passwd", 3])).toEqual(["src/a.ts", "b"]);
    expect(cleanPaths("nope")).toEqual([]);
  });
});
