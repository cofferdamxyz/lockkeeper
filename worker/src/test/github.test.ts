import { beforeEach, describe, expect, it } from "vitest";

import { appJwt, ciFromCheckRuns, ciFromComments, GitHub, importAppKey, pkcs1ToPkcs8, resetTokenCache } from "../github";
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
  const marker = "<!-- cofferdam-ci:";
  it("reads the worst job on the current head", () => {
    expect(ciFromComments([bot("<!-- cofferdam-ci:check -->\n### CI ✅ passed · `check` on abcdef0")], head, marker)).toBe("pass");
    expect(
      ciFromComments([bot("<!-- cofferdam-ci:a -->\n### CI ✅ passed · `a` on abcdef0"), bot("<!-- cofferdam-ci:b -->\n### CI ❌ failed · `b` on abcdef0")], head, marker),
    ).toBe("fail");
    expect(ciFromComments([bot("<!-- cofferdam-ci:a -->\n### CI ❌ failed · `a` on 1111111")], head, marker)).toBe("pending");
    expect(ciFromComments([{ body: "### CI ✅ passed · `a` on abcdef0 <!-- cofferdam-ci:a -->", user: { type: "User" }, updated_at: "" }], head, marker)).toBe("none");
  });

  it("reads only comments that carry the configured marker", () => {
    const passed = bot("<!-- cofferdam-ci:check -->\n### CI ✅ passed · `check` on abcdef0");
    expect(ciFromComments([passed], head, "<!-- lockkeeper-ci:")).toBe("none");
    expect(ciFromComments([bot("<!-- lockkeeper-ci:test -->\n### CI ✅ passed · `test` on abcdef0")], head, "<!-- lockkeeper-ci:")).toBe("pass");
    expect(ciFromComments([passed], head, "")).toBe("none"); // an empty marker would match every comment
  });

  it("needs the marker to open the comment", () => {
    // A bot that quotes text a pull request chose (a title, a commit message) must not carry a CI report.
    const quoted = bot("Preview for \"x\"\n<!-- cofferdam-ci:check -->\n### CI ✅ passed · `check` on abcdef0");
    expect(ciFromComments([quoted], head, marker)).toBe("none");
  });
});

describe("CI from the check runs", () => {
  const run = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion });
  it("is the worst of the runs on the head", () => {
    expect(ciFromCheckRuns([])).toBe("none");
    expect(ciFromCheckRuns([run("test", "completed", "success")])).toBe("pass");
    expect(ciFromCheckRuns([run("test", "completed", "success"), run("lint", "in_progress")])).toBe("pending");
    expect(ciFromCheckRuns([run("test", "completed", "success"), run("lint", "queued"), run("e2e", "completed", "failure")])).toBe("fail");
    for (const conclusion of ["failure", "timed_out", "cancelled", "action_required", "startup_failure", null]) {
      expect(ciFromCheckRuns([run("test", "completed", "success"), run("x", "completed", conclusion)])).toBe("fail");
    }
    expect(ciFromCheckRuns([run("test", "completed", "success"), run("x", "completed", "stale")])).toBe("pending");
  });

  it("never reads skipped or neutral runs as green", () => {
    expect(ciFromCheckRuns([run("a", "completed", "skipped"), run("b", "completed", "neutral")])).toBe("none");
    expect(ciFromCheckRuns([run("a", "completed", "skipped"), run("test", "completed", "success")])).toBe("pass");
  });

  it("leaves out the runs the configuration ignores, by name", () => {
    const runs = [run("test", "completed", "success"), run("CodeQL / analyze (js)", "completed", "failure"), run("deploy-preview", "in_progress")];
    expect(ciFromCheckRuns(runs)).toBe("fail");
    expect(ciFromCheckRuns(runs, { ignore: ["CodeQL*"] })).toBe("pending");
    expect(ciFromCheckRuns(runs, { ignore: ["CodeQL*", "deploy-preview"] })).toBe("pass");
    expect(ciFromCheckRuns(runs, { ignore: ["CodeQL", "deploy"] })).toBe("fail"); // a pattern is the whole name, not a prefix
    expect(ciFromCheckRuns([run("a.b", "completed", "failure")], { ignore: ["axb"] })).toBe("fail"); // a dot is a dot
    expect(ciFromCheckRuns(runs, { ignore: ["*"] })).toBe("none");
  });

  it("is not green on some other check's success when the CI it requires did not run", () => {
    // `[skip ci]`, a paths filter or a merge conflict leaves the CI absent; a deploy app still reports.
    const others = [run("Vercel", "completed", "success"), run("CodeQL", "completed", "neutral")];
    expect(ciFromCheckRuns(others)).toBe("pass"); // with nothing required, any success is green
    expect(ciFromCheckRuns(others, { require: ["test"] })).toBe("pending");
    expect(ciFromCheckRuns([...others, run("test", "completed", "success")], { require: ["test"] })).toBe("pass");
    expect(ciFromCheckRuns([...others, run("test", "completed", "skipped")], { require: ["test"] })).toBe("pending"); // present, not successful
    expect(ciFromCheckRuns([...others, run("test (node 24)", "completed", "success")], { require: ["test*", "lint"] })).toBe("pending"); // every pattern needs its success
    expect(ciFromCheckRuns([...others, run("test (node 24)", "completed", "success"), run("lint", "completed", "success")], { require: ["test*", "lint"] })).toBe("pass");
    expect(ciFromCheckRuns([], { require: ["test"] })).toBe("none"); // no run at all: nothing is known
    expect(ciFromCheckRuns([run("test", "completed", "success")], { require: ["test"], ignore: ["test"] })).toBe("none"); // ignored runs cannot satisfy a requirement
  });

  it("is pending when the head has more runs than were read", () => {
    const runs = [run("test", "completed", "success")];
    expect(ciFromCheckRuns(runs, { complete: false })).toBe("pending"); // a failure may sit on a page not read
    expect(ciFromCheckRuns([...runs, run("x", "completed", "failure")], { complete: false })).toBe("fail");
    expect(ciFromCheckRuns(runs, { complete: true })).toBe("pass");
  });
});
