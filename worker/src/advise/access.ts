import type { AdviseEnv } from "./env";

/**
 * Cloudflare Access sits in front of `lockkeeper.cofferdam.xyz` (the `cofferdam` team). Access
 * signs every request it lets through with `Cf-Access-Jwt-Assertion`; the Worker verifies it
 * again so a misconfigured hostname or a direct `workers.dev` hit fails closed. People carry an
 * `email`; a service token (Claude Code's MCP config and hooks) carries `common_name`, its
 * client id.
 */

export interface Identity {
  /** Email for a person, `service:<client id>` for a service token. */
  who: string;
  kind: "person" | "service" | "development";
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const keyCache = new Map<string, { keys: Map<string, CryptoKey>; at: number }>();

export function resetAccessKeys(): void {
  keyCache.clear();
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function keysFor(team: string, fetcher: typeof fetch, nowMs: number): Promise<Map<string, CryptoKey>> {
  const hit = keyCache.get(team);
  if (hit && nowMs - hit.at < 10 * 60_000) return hit.keys;
  const res = await fetcher(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys ?? []) {
    if (k.kty !== "RSA") continue;
    keys.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  keyCache.set(team, { keys, at: nowMs });
  return keys;
}

export class AccessError extends Error {
  constructor(
    readonly status: 401 | 503,
    message: string,
  ) {
    super(message);
  }
}

export async function verifyAccess(
  env: Pick<AdviseEnv, "ACCESS_AUD" | "ACCESS_TEAM_DOMAIN" | "ENVIRONMENT">,
  request: Request,
  opts: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<Identity> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!env.ACCESS_AUD) {
    if (env.ENVIRONMENT === "development") return { who: "development", kind: "development" };
    throw new AccessError(503, "Access is not configured (ACCESS_AUD is empty)");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new AccessError(401, "no Access assertion");
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new AccessError(401, "malformed Access assertion");
  let header: { kid?: string; alg?: string };
  let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; common_name?: string; sub?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(h)));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(p)));
  } catch {
    throw new AccessError(401, "malformed Access assertion");
  }
  if (header.alg !== "RS256" || !header.kid) throw new AccessError(401, "unexpected Access algorithm");
  const team = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
  const keys = await keysFor(team, opts.fetcher ?? ((i, init) => fetch(i, init)), nowMs);
  let key = keys.get(header.kid);
  if (!key) {
    keyCache.delete(team); // rotated: fetch once more
    key = (await keysFor(team, opts.fetcher ?? ((i, init) => fetch(i, init)), nowMs)).get(header.kid);
  }
  if (!key) throw new AccessError(401, "unknown Access signing key");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AccessError(401, "bad Access signature");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new AccessError(401, "Access assertion for another application");
  if (claims.iss !== team) throw new AccessError(401, "Access assertion from another team");
  const nowS = nowMs / 1000;
  if (!claims.exp || claims.exp < nowS - 30) throw new AccessError(401, "Access assertion expired");
  if (claims.nbf && claims.nbf > nowS + 30) throw new AccessError(401, "Access assertion not yet valid");
  if (claims.email) return { who: claims.email, kind: "person" };
  if (claims.common_name) return { who: `service:${claims.common_name}`, kind: "service" };
  throw new AccessError(401, "Access assertion names nobody");
}

