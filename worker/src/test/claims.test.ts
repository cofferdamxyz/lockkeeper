import { beforeEach, describe, expect, it } from "vitest";

import { ClaimError, createClaim, dropClaim } from "../claims";
import config from "../../../lockkeeper.config";
import { resetDb, testEnv } from "./fakes";

describe("the limit on live claims", () => {
  beforeEach(async () => resetDb(await testEnv()));

  it("stops one identity filling the list every reader loads, and no one else", async () => {
    const env = await testEnv();
    const settings = { ...config, claims: { ...config.claims, maxLive: 3 } };
    const take = (who: string, n: number) => createClaim(env, who, { repo: "cofferdam-api", goal: `work ${n}` }, { settings });
    const mine = [await take("a@example.com", 1), await take("a@example.com", 2), await take("a@example.com", 3)];
    await expect(take("a@example.com", 4)).rejects.toMatchObject({ status: 429 });
    await expect(take("a@example.com", 4)).rejects.toBeInstanceOf(ClaimError);
    await take("b@example.com", 1); // another identity is not held back
    await dropClaim(env, "a@example.com", mine[0].id);
    await take("a@example.com", 4); // and a released claim frees a place
  });

  it("is fifty unless the configuration says otherwise", () => {
    expect(config.claims.maxLive).toBe(50);
  });
});
