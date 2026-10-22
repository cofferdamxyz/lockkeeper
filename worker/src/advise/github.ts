/**
 * GitHub, read through Lockkeeper's own GitHub App (workspace decision 0053): metadata and
 * contents read, pull requests write (comments, from step 3 of DESIGN.md §13; nothing writes yet).
 * The App's private key is a Wrangler secret; installation tokens live in memory for under an hour.
 */

export interface GitHubAppAuth {
  appId: string;
  /** The App's private key as GitHub hands it out (PKCS#1, `BEGIN RSA PRIVATE KEY`) or PKCS#8. */
  privateKey: string;
  owner: string;
}

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const API = "https://api.github.com";

// ---------- keys and the App JWT ----------

function pemBody(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** Wraps a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo, which is all WebCrypto imports. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  // AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const inner = version.length + algorithm.length + octet.length + pkcs1.length;
  const head = [0x30, ...derLength(inner), ...version, ...algorithm, ...octet];
  const out = new Uint8Array(head.length + pkcs1.length);
  out.set(head, 0);
  out.set(pkcs1, head.length);
  return out;
}

export async function importAppKey(pem: string): Promise<CryptoKey> {
  const der = pemBody(pem);
  const pkcs8 = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export function base64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The App JWT: RS256, issued a minute in the past for clock drift, nine minutes of life. */
export async function appJwt(appId: string, key: CryptoKey, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const input = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${base64url(sig)}`;
}

// ---------- the client ----------

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`GitHub ${status} on ${path}: ${message}`);
  }
}

export interface RepoInfo {
  name: string;
  full_name: string;
  default_branch: string;
  archived: boolean;
  pushed_at: string | null;
}

export interface BranchInfo {
  name: string;
  commit: { sha: string };
}

export interface PullInfo {
  number: number;
  title: string;
  draft: boolean;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
  updated_at: string;
}

export interface CompareInfo {
  ahead_by: number;
  behind_by: number;
  merge_base_commit: { sha: string };
  commits: { sha: string; commit: { message: string; author: { name: string; date: string } | null }; author: { login: string } | null }[];
  files?: { filename: string; previous_filename?: string }[];
}

export interface CommentInfo {
  body: string;
  user: { type: string } | null;
  updated_at: string;
}

let tokenCache: { key: string; token: string; expires: number } | null = null;

/** Forget the cached installation token (tests, and after a 401). */
export function resetTokenCache(): void {
  tokenCache = null;
}

export class GitHub {
  private installationId: number | null = null;
  calls = 0;

  constructor(
    private readonly auth: GitHubAppAuth,
    private readonly fetcher: Fetch = (i, init) => fetch(i, init),
  ) {}

  private async raw(path: string, init: RequestInit & { token: string }): Promise<Response> {
    this.calls++;
    const url = path.startsWith("http") ? path : `${API}${path}`;
    return this.fetcher(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "lockkeeper-cofferdam",
        authorization: `Bearer ${init.token}`,
        ...(init.headers ?? {}),
      },
    });
  }

  private async installationToken(): Promise<string> {
    const cacheKey = `${this.auth.appId}:${this.auth.owner}`;
    if (tokenCache && tokenCache.key === cacheKey && tokenCache.expires > Date.now() + 5 * 60_000) return tokenCache.token;
    const key = await importAppKey(this.auth.privateKey);
    const jwt = await appJwt(this.auth.appId, key);
    if (this.installationId === null) {
      const res = await this.raw(`/orgs/${this.auth.owner}/installation`, { method: "GET", token: jwt });
      // A personal account answers on /users/:owner/installation instead.
      const found = res.status === 404 ? await this.raw(`/users/${this.auth.owner}/installation`, { method: "GET", token: jwt }) : res;
      if (!found.ok) throw new GitHubError(found.status, "installation", await found.text());
      this.installationId = ((await found.json()) as { id: number }).id;
    }
    const res = await this.raw(`/app/installations/${this.installationId}/access_tokens`, { method: "POST", token: jwt });
    if (!res.ok) throw new GitHubError(res.status, "access_tokens", await res.text());
    const body = (await res.json()) as { token: string; expires_at: string };
    tokenCache = { key: cacheKey, token: body.token, expires: Date.parse(body.expires_at) };
    return body.token;
  }

  async get<T>(path: string): Promise<T> {
    const token = await this.installationToken();
    const res = await this.raw(path, { method: "GET", token });
    if (!res.ok) throw new GitHubError(res.status, path, (await res.text()).slice(0, 300));
    return (await res.json()) as T;
  }

  /** Follows `Link: rel="next"` up to `maxPages` pages. */
  async list<T>(path: string, maxPages = 3, pick?: (body: unknown) => T[]): Promise<T[]> {
    const token = await this.installationToken();
    const out: T[] = [];
    let next: string | null = path;
    for (let page = 0; next && page < maxPages; page++) {
      const res = await this.raw(next, { method: "GET", token });
      if (!res.ok) throw new GitHubError(res.status, next, (await res.text()).slice(0, 300));
      const body = (await res.json()) as unknown;
      out.push(...(pick ? pick(body) : (body as T[])));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    }
    return out;
  }

  repositories(): Promise<RepoInfo[]> {
    return this.list<RepoInfo>("/installation/repositories?per_page=100", 5, (b) => (b as { repositories: RepoInfo[] }).repositories);
  }

  branches(repo: string): Promise<BranchInfo[]> {
    return this.list<BranchInfo>(`/repos/${repo}/branches?per_page=100`);
  }

  pulls(repo: string): Promise<PullInfo[]> {
    return this.list<PullInfo>(`/repos/${repo}/pulls?state=open&per_page=100`, 2);
  }

  compare(repo: string, base: string, head: string): Promise<CompareInfo> {
    return this.get<CompareInfo>(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`);
  }

  comments(repo: string, issue: number): Promise<CommentInfo[]> {
    return this.list<CommentInfo>(`/repos/${repo}/issues/${issue}/comments?per_page=100`, 1);
  }
}

// ---------- CI, as the repositories report it ----------

export type CiState = "pass" | "fail" | "pending" | "none";

/**
 * Cofferdam CI posts one comment per job on a pull request (`<!-- cofferdam-ci:<job> -->`, then
 * `### CI ✅ passed · \`job\` on <sha7>`), updated in place; the App cannot read check runs.
 * The state for a head is the worst of the jobs that ran on it.
 */
export function ciFromComments(comments: CommentInfo[], headSha: string): CiState {
  const sha7 = headSha.slice(0, 7);
  let seen = false;
  let stale = false;
  let failed = false;
  for (const c of comments) {
    if (c.user?.type !== "Bot" || !c.body.includes("<!-- cofferdam-ci:")) continue;
    const m = /### CI (✅ passed|❌ failed)[^\n]* on ([0-9a-f]{7})/.exec(c.body);
    if (!m) continue;
    if (m[2] !== sha7) {
      stale = true;
      continue;
    }
    seen = true;
    if (m[1].startsWith("❌")) failed = true;
  }
  if (failed) return "fail";
  if (stale) return "pending";
  return seen ? "pass" : "none";
}
