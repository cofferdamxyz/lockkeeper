import { beforeEach, describe, expect, it } from "vitest";

import { AccessError, resetAccessKeys, verifyAccess } from "../access";
import { fakeAccess, testEnv } from "./fakes";

const req = (token?: string) => new Request("https://lockkeeper.cofferdam.xyz/v1/brief", { headers: token ? { "cf-access-jwt-assertion": token } : {} });

describe("Access", () => {
  beforeEach(() => resetAccessKeys());

  it("accepts a person and a service token, by email and by client id", async () => {
    const env = await testEnv();
    const a = await fakeAccess();
    expect(await verifyAccess(env, req(await a.sign(a.claims({ email: "hoff@cofferdam.xyz" }))), { fetcher: a.fetcher })).toEqual({ who: "hoff@cofferdam.xyz", kind: "person" });
    expect(await verifyAccess(env, req(await a.sign(a.claims({ common_name: "abc.access" }))), { fetcher: a.fetcher })).toEqual({ who: "service:abc.access", kind: "service" });
  });

  it("refuses a missing, foreign, expired or forged assertion", async () => {
    const env = await testEnv();
    const a = await fakeAccess();
    const other = await fakeAccess();
    const cases = [
      req(),
      req("not.a.jwt"),
      req(await a.sign(a.claims({ email: "x@y", aud: ["another-app"] }))),
      req(await a.sign(a.claims({ email: "x@y", iss: "https://evil.cloudflareaccess.com" }))),
      req(await a.sign(a.claims({ email: "x@y", exp: Math.floor(Date.now() / 1000) - 120 }))),
      req(await other.sign(a.claims({ email: "x@y" }))), // signed by a key the team never published
      req(await a.sign(a.claims({}))),
    ];
    for (const r of cases) await expect(verifyAccess(env, r, { fetcher: a.fetcher })).rejects.toBeInstanceOf(AccessError);
  });

  it("fails closed without an audience, except in development", async () => {
    const a = await fakeAccess();
    await expect(verifyAccess(await testEnv({ ACCESS_AUD: "" }), req(), { fetcher: a.fetcher })).rejects.toMatchObject({ status: 503 });
    expect((await verifyAccess(await testEnv({ ACCESS_AUD: "", ENVIRONMENT: "development" }), req())).kind).toBe("development");
  });
});
