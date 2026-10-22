import { env as bindings } from "cloudflare:workers";

import { base64url, resetTokenCache, type CommentInfo } from "../github";
import { resetAccessKeys } from "../access";
import type { AdviseEnv } from "../env";

/** A fake GitHub: repositories with a linear `main`, branches forked off it, pull requests and CI comments. */

export interface FakeCommit {
  sha: string;
  message: string;
  files: string[];
  author?: string;
  date?: string;
}

export interface FakeRepo {
  name: string;
  defaultBranch?: string;
  pushedAt: string;
  archived?: boolean;
  main: FakeCommit[];
  branches: Record<string, { base: string; commits: FakeCommit[] }>;
  pulls?: { number: number; title: string; branch: string; draft?: boolean }[];
  comments?: Record<number, CommentInfo[]>;
}

export interface FakeGitHub {
  owner: string;
  repos: FakeRepo[];
  calls: string[];
}

let counter = 0;
export function commit(message: string, files: string[], date = "2026-10-22T01:00:00Z"): FakeCommit {
  counter++;
  const sha = (counter.toString(16).padStart(8, "0") + "a".repeat(32)).slice(0, 40);
  return { sha, message, files, author: "CofferdamDev", date };
}

function lineage(repo: FakeRepo, ref: string): FakeCommit[] {
  if (ref === (repo.defaultBranch ?? "main")) return repo.main;
  const b = repo.branches[ref];
  if (b) {
    const i = repo.main.findIndex((c) => c.sha === b.base);
    return [...repo.main.slice(0, i + 1), ...b.commits];
  }
  const onMain = repo.main.findIndex((c) => c.sha === ref);
  if (onMain >= 0) return repo.main.slice(0, onMain + 1);
  for (const br of Object.values(repo.branches)) {
    const k = br.commits.findIndex((c) => c.sha === ref);
    if (k >= 0) {
      const i = repo.main.findIndex((c) => c.sha === br.base);
      return [...repo.main.slice(0, i + 1), ...br.commits.slice(0, k + 1)];
    }
  }
  throw new Error(`unknown ref ${ref}`);
}

function headOf(repo: FakeRepo, name: string): string {
  const l = lineage(repo, name);
  return l[l.length - 1].sha;
}

export function fakeFetch(gh: FakeGitHub) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    gh.calls.push(`${method} ${url.pathname}${url.search}`);
    const json = (b: unknown, status = 200) => Response.json(b, { status });
    const p = url.pathname;
    if (p === `/orgs/${gh.owner}/installation`) return json({ id: 77 });
    if (p === "/app/installations/77/access_tokens" && method === "POST") return json({ token: "ghs_fake", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    if (auth !== "Bearer ghs_fake") return json({ message: "Bad credentials" }, 401);
    if (p === "/installation/repositories") {
      return json({
        repositories: gh.repos.map((r) => ({ name: r.name, full_name: `${gh.owner}/${r.name}`, default_branch: r.defaultBranch ?? "main", archived: Boolean(r.archived), pushed_at: r.pushedAt })),
      });
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(p);
    if (!m) return json({ message: "Not Found" }, 404);
    const repo = gh.repos.find((r) => r.name === m[2]);
    if (!repo) return json({ message: "Not Found" }, 404);
    const rest = m[3];
    if (rest === "branches") {
      const names = [repo.defaultBranch ?? "main", ...Object.keys(repo.branches)];
      return json(names.map((name) => ({ name, commit: { sha: headOf(repo, name) } })));
    }
    if (rest === "pulls") {
      return json(
        (repo.pulls ?? []).map((pr) => ({
          number: pr.number,
          title: pr.title,
          draft: Boolean(pr.draft),
          html_url: `https://github.com/${gh.owner}/${repo.name}/pull/${pr.number}`,
          user: { login: "CofferdamDev" },
          head: { ref: pr.branch, sha: headOf(repo, pr.branch), repo: { full_name: `${gh.owner}/${repo.name}` } },
          base: { ref: repo.defaultBranch ?? "main" },
          updated_at: "2026-10-22T01:00:00Z",
        })),
      );
    }
    const cm = /^issues\/(\d+)\/comments$/.exec(rest);
    if (cm) return json(repo.comments?.[Number(cm[1])] ?? []);
    const cmp = /^compare\/(.+)\.\.\.(.+)$/.exec(rest);
    if (cmp) {
      const base = lineage(repo, decodeURIComponent(cmp[1]));
      const head = lineage(repo, decodeURIComponent(cmp[2]));
      let k = 0;
      while (k < base.length && k < head.length && base[k].sha === head[k].sha) k++;
      const ahead = head.slice(k);
      const files = [...new Set(ahead.flatMap((c) => c.files))].map((filename) => ({ filename }));
      return json({
        ahead_by: ahead.length,
        behind_by: base.length - k,
        merge_base_commit: { sha: base[k - 1].sha },
        commits: ahead.map((c) => ({ sha: c.sha, commit: { message: c.message, author: { name: c.author ?? "x", date: c.date ?? "2026-10-22T01:00:00Z" } }, author: { login: c.author ?? "x" } })),
        files,
      });
    }
    return json({ message: "Not Found" }, 404);
  };
}

export async function rsaKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

function pem(label: string, der: Uint8Array): string {
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** A PKCS#1 PEM, the form GitHub hands out, plus the PKCS#8 bytes it should become. */
export async function appKeyPem(): Promise<{ pem: string; pkcs8: Uint8Array; publicKey: CryptoKey }> {
  const pair = await rsaKeyPair();
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  // PrivateKeyInfo for a 2048-bit RSA key: 26 header bytes, then the PKCS#1 RSAPrivateKey.
  return { pem: pem("RSA PRIVATE KEY", pkcs8.slice(26)), pkcs8, publicKey: pair.publicKey };
}

let cachedKey: string | null = null;

/** The test environment: the pool's D1, a real (throwaway) App key, no AI or Vectorize. */
export async function testEnv(overrides: Partial<AdviseEnv> = {}): Promise<AdviseEnv> {
  cachedKey ??= (await appKeyPem()).pem;
  const b = bindings as unknown as AdviseEnv;
  return { ...b, AI: undefined, VECTORIZE: undefined, GITHUB_APP_PRIVATE_KEY: cachedKey, ...overrides };
}

export async function resetDb(env: AdviseEnv): Promise<void> {
  await env.DB.batch(["repos", "branches", "main_moves", "claims", "settings"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  resetTokenCache();
  resetAccessKeys();
}

/** Access: a team key pair, its certs endpoint, and signed assertions. */
export async function fakeAccess() {
  const pair = await rsaKeyPair();
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const certs = { keys: [{ kid: "k1", kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e }] };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://cofferdam.cloudflareaccess.com/cdn-cgi/access/certs") return Response.json(certs);
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const sign = async (claims: Record<string, unknown>, kid = "k1", key = pair.privateKey) => {
    const h = base64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const p = base64url(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)));
    return `${h}.${p}.${base64url(sig)}`;
  };
  const claims = (extra: Record<string, unknown> = {}) => ({
    aud: ["test-aud"],
    iss: "https://cofferdam.cloudflareaccess.com",
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    ...extra,
  });
  return { fetcher, sign, claims };
}
