/**
 * Path arithmetic for the advisory deployment: globs, overlap between path sets, and the
 * sensitive-path list. Pure, so it runs anywhere.
 *
 * A path set may hold exact files (`src/a.ts`), directories (`src/lib/`) and globs
 * (`src/lib/**`, `*.md`). Claims usually name directories or globs, branches always name files.
 */

const cache = new Map<string, RegExp>();

export function isPattern(p: string): boolean {
  return p.includes("*") || p.includes("?") || p.endsWith("/");
}

/** `*` and `?` stay inside a segment, `**` crosses segments, a trailing `/` means everything below. */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  const g = glob.endsWith("/") ? `${glob}**` : glob;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // `**/` matches zero or more whole segments; a bare `**` matches anything.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export function matches(pattern: string, path: string): boolean {
  if (!isPattern(pattern)) return pattern === path;
  return globToRegExp(pattern).test(path);
}

/** The longest literal directory a pattern starts with, used when two patterns meet. */
function literalPrefix(pattern: string): string {
  const star = pattern.search(/[*?]/);
  const head = star === -1 ? pattern : pattern.slice(0, star);
  return head.slice(0, head.lastIndexOf("/") + 1);
}

/**
 * Whether two entries can name the same file. Two patterns overlap when one's literal
 * directory contains the other's (a cheap, conservative answer: it may say yes when the globs
 * could never meet, never no when they can).
 */
export function entriesOverlap(a: string, b: string): boolean {
  const pa = isPattern(a);
  const pb = isPattern(b);
  if (!pa && !pb) return a === b;
  if (pa && !pb) return matches(a, b);
  if (!pa && pb) return matches(b, a);
  const la = literalPrefix(a);
  const lb = literalPrefix(b);
  return la.startsWith(lb) || lb.startsWith(la);
}

/** Entries of `a` that meet some entry of `b`, in `a`'s order. */
export function sharedPaths(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  return a.filter((x) => b.some((y) => entriesOverlap(x, y)));
}

/**
 * Sensitive entries a path set touches. Globs in the list are `<repo>/<path>`; a leading `**`
 * applies to every repository.
 */
export function sensitiveHits(repo: string, paths: string[], sensitive: string[]): string[] {
  const name = repo.includes("/") ? repo.slice(repo.indexOf("/") + 1) : repo;
  const hits: string[] = [];
  for (const p of paths) {
    const full = `${name}/${p}`;
    if (sensitive.some((g) => entriesOverlap(g, full))) hits.push(p);
  }
  return hits;
}

/** Normalise what a client sends: trimmed, no leading `./` or `/`, no blanks, no duplicates. */
export function cleanPaths(input: unknown, max = 500): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const p = raw.trim().replace(/^\.\//, "").replace(/^\/+/, "");
    if (p && p.length <= 400 && !p.split("/").includes("..")) out.add(p);
    if (out.size >= max) break;
  }
  return [...out];
}
