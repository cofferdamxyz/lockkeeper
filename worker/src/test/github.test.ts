import { beforeEach, describe, expect, it } from "vitest";

import { appJwt, ciFromComments, GitHub, importAppKey, pkcs1ToPkcs8, resetTokenCache } from "../github";
import { appKeyPem, fakeFetch, type FakeGitHub } from "./fakes";

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe("the App key", () => {
  it("wraps GitHub's PKCS#1 key into the PKCS#8 WebCrypto imports", async () => {
    const { pem, pkcs8 } = await appKeyPem();
    const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const pkcs1 = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    expect(Array.from(pkcs1ToPkcs8(pkcs1))).toEqual(Array.from(pkcs8));
  });

  it("signs an RS256 App JWT that the App's public key verifies", async () => {
    const { pem, publicKey } = await appKeyPem();
    const jwt = await appJwt("12345", await importAppKey(pem), 1_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(p)))).toEqual({ iat: 999_940, exp: 1_000_540, iss: "12345" });
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });
});

describe("the client", () => {
  beforeEach(() => resetTokenCache());

  it("finds the installation, mints a token once and reuses it", async () => {
    const gh: FakeGitHub = { owner: "cofferdamxyz", repos: [], calls: [] };
    const { pem } = await appKeyPem();
    const client = new GitHub({ appId: "1", privateKey: pem, owner: "cofferdamxyz" }, fakeFetch(gh));
    await client.repositories();
    await client.repositories();
    expect(gh.calls.filter((c) => c.includes("access_tokens"))).toHaveLength(1);
    expect(gh.calls[0]).toBe("GET /orgs/cofferdamxyz/installation");
  });
});

describe("CI from the pull request comments", () => {
  const bot = (body: string) => ({ body, user: { type: "Bot" }, updated_at: "" });
  const head = "abcdef0123456789";
  it("reads the worst job on the current head", () => {
    expect(ciFromComments([bot("<!-- cofferdam-ci:check -->\n### CI ✅ passed · `check` on abcdef0")], head)).toBe("pass");
    expect(
      ciFromComments([bot("<!-- cofferdam-ci:a -->\n### CI ✅ passed · `a` on abcdef0"), bot("<!-- cofferdam-ci:b -->\n### CI ❌ failed · `b` on abcdef0")], head),
    ).toBe("fail");
    expect(ciFromComments([bot("<!-- cofferdam-ci:a -->\n### CI ❌ failed · `a` on 1111111")], head)).toBe("pending");
    expect(ciFromComments([{ body: "### CI ✅ passed · `a` on abcdef0 <!-- cofferdam-ci:a -->", user: { type: "User" }, updated_at: "" }], head)).toBe("none");
  });
});
