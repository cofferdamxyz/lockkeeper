/**
 * GitHub, read through Lockkeeper's own GitHub App: metadata, contents and checks read, pull
 * requests write (DESIGN.md, "The advising pass": one advice comment per candidate pull request,
 * created once and edited in place; nothing else is ever written).
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

/** One check run on a commit, as GitHub lists it. `name` is chosen by whoever made the run: never shown, only matched. */
export interface CheckRunInfo {
  name: string;
  /** `queued`, `in_progress`, `completed`, and GitHub's other waiting states. */
  status: string;
  /** Set once `status` is `completed`. */
  conclusion: string | null;
}

/** Every path a compare touches: a renamed file counts under its old name too, since that path changed as well. */
export function changedPaths(cmp: CompareInfo): string[] {
  return [...new Set((cmp.files ?? []).flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])))];
}

export interface CommentInfo {
  /** Absent only in old fixtures; GitHub always sends it. */
  id?: number;
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
        "user-agent": "lockkeeper",
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

  /** Follows `Link: rel="next"` up to `maxPages` pages; `more` says GitHub had pages beyond them. */
  async pages<T>(path: string, maxPages = 3, pick?: (body: unknown) => T[]): Promise<{ items: T[]; more: boolean }> {
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
    return { items: out, more: next !== null };
  }

  async list<T>(path: string, maxPages = 3, pick?: (body: unknown) => T[]): Promise<T[]> {
    return (await this.pages(path, maxPages, pick)).items;
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

  /**
   * The latest check runs on one commit (needs Checks read on the App; GitHub answers 403 without
   * it). `complete` is false when the commit has more runs than the three pages read.
   */
  async checkRuns(repo: string, sha: string): Promise<{ runs: CheckRunInfo[]; complete: boolean }> {
    const { items, more } = await this.pages<CheckRunInfo>(`/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`, 3, (b) => (b as { check_runs: CheckRunInfo[] }).check_runs);
    return { runs: items, complete: !more };
  }

  /** A pull request's comments, oldest first, three pages at most; `more` says there are comments beyond them. */
  commentPages(repo: string, issue: number): Promise<{ items: CommentInfo[]; more: boolean }> {
    return this.pages<CommentInfo>(`/repos/${repo}/issues/${issue}/comments?per_page=100`, 3);
  }

  comments(repo: string, issue: number, maxPages = 1): Promise<CommentInfo[]> {
    return this.list<CommentInfo>(`/repos/${repo}/issues/${issue}/comments?per_page=100`, maxPages);
  }

  /** One closed or open pull request: whether it merged. */
  pull(repo: string, number: number): Promise<{ state: string; merged: boolean; merged_at: string | null }> {
    return this.get(`/repos/${repo}/pulls/${number}`);
  }

  /**
   * The only writes this deployment makes besides its token: the advice comment on a pull
   * request, created once (`id` null) and edited in place afterwards.
   */
  async writeComment(repo: string, pull: number, id: number | null, body: string): Promise<number> {
    const token = await this.installationToken();
    const path = id === null ? `/repos/${repo}/issues/${pull}/comments` : `/repos/${repo}/issues/comments/${id}`;
    const res = await this.raw(path, {
      method: id === null ? "POST" : "PATCH",
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new GitHubError(res.status, path, (await res.text()).slice(0, 300));
    return ((await res.json()) as { id: number }).id;
  }
}

// ---------- CI, as the repositories report it ----------

export type CiState = "pass" | "fail" | "pending" | "none";

/** The first line of Lockkeeper's own advice comment (advice.ts). Never read as a CI report. */
export const ADVICE_MARKER = "<!-- lockkeeper-advice -->";

/** `*` in a pattern stands for any run of characters; everything else is literal. */
function nameMatches(pattern: string, name: string): boolean {
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + "$").test(name);
}

/**
 * CI from the check runs on a head (`ci.sources: "checks"`). The state is the worst of the runs
 * that count: one that did not succeed is `fail`; one still running or gone stale is `pending`,
 * and so is a head whose runs could not all be read, or that lacks a success from a run the
 * configuration requires. `pass` needs at least one success, so a head whose runs were all
 * skipped or neutral says nothing (`none`), like a head with no run at all.
 */
export function ciFromCheckRuns(runs: CheckRunInfo[], opts: { ignore?: string[]; require?: string[]; complete?: boolean } = {}): CiState {
  const ignore = opts.ignore ?? [];
  const succeeded: string[] = [];
  let counted = 0;
  let pending = false;
  let failed = false;
  for (const r of runs) {
    if (ignore.some((pattern) => nameMatches(pattern, r.name))) continue;
    counted++;
    if (r.status !== "completed" || r.conclusion === "stale") pending = true;
    else if (r.conclusion === "success") succeeded.push(r.name);
    else if (r.conclusion !== "neutral" && r.conclusion !== "skipped") failed = true; // failure, timed_out, cancelled, action_required, startup_failure, or nothing
  }
  if (failed) return "fail";
  if (pending || opts.complete === false) return "pending";
  // A run the configuration requires has not succeeded here: the CI did not run on this head (yet).
  if ((opts.require ?? []).some((pattern) => !succeeded.some((name) => nameMatches(pattern, name)))) return counted ? "pending" : "none";
  return succeeded.length ? "pass" : "none";
}

/**
 * CI from a comment (`ci.sources: "comment"`), for an App that cannot read check runs: each CI
 * job keeps one comment on the pull request, updated in place, whose first line opens with
 * `marker` (`<marker><job> -->`) and whose heading reads `### CI ✅ passed · \`job\` on <sha7>`
 * (or `❌ failed`). The state for a head is the worst of the jobs that ran on it.
 */
export function ciFromComments(comments: CommentInfo[], headSha: string, marker: string): CiState {
  if (!marker) return "none";
  const sha7 = headSha.slice(0, 7);
  let seen = false;
  let stale = false;
  let failed = false;
  for (const c of comments) {
    // Lockkeeper's own comment quotes file names from the pull request: it is never evidence of CI.
    // The marker opens the comment: a bot that quotes text a pull request chose cannot carry one.
    if (c.user?.type !== "Bot" || c.body.startsWith(ADVICE_MARKER) || !c.body.startsWith(marker)) continue;
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
