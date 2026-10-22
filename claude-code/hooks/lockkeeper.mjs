#!/usr/bin/env node
// Lockkeeper's Claude Code hooks (DESIGN.md §13 step 2). Two touchpoints, nothing after a push:
//   node lockkeeper.mjs session-start   SessionStart: the brief for this repository (or each
//                                       repository under the working directory, in a cloud session)
//   node lockkeeper.mjs pre-tool        PreToolUse on Bash: before `git commit` and `git push`,
//                                       what moved on the default branch and what is in flight
// Awareness, never a lock: every failure (no network, no credentials, Lockkeeper down) exits 0
// silently and the session carries on. With LOCKKEEPER_PUSH=hold-once a push whose files collide
// with what landed on main is held once with the reason; the same push again goes through.
//
// Environment: LOCKKEEPER_URL (https://lockkeeper.cofferdam.xyz), LOCKKEEPER_ACCESS_CLIENT_ID and
// LOCKKEEPER_ACCESS_CLIENT_SECRET (a Cloudflare Access service token). Node 18 or newer.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_BASE = (process.env.LOCKKEEPER_URL ?? "").replace(/\/+$/, "");
const ID = process.env.LOCKKEEPER_ACCESS_CLIENT_ID ?? "";
const SECRET = process.env.LOCKKEEPER_ACCESS_CLIENT_SECRET ?? "";
const TIMEOUT_MS = Number(process.env.LOCKKEEPER_TIMEOUT_MS ?? 4000);
const MAX_CONTEXT = 9000;

export function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
  } catch {
    return "";
  }
}

/** owner/name from any remote URL: github.com over https or ssh, or a proxy path ending in owner/name. */
export function repoFromRemote(url) {
  const m = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function repoState(dir) {
  const remote = git(dir, ["remote", "get-url", "origin"]);
  const repo = remote && repoFromRemote(remote);
  if (!repo) return null;
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
  const defaultBranch = head || (git(dir, ["rev-parse", "--verify", "--quiet", "origin/main"]) ? "main" : "master");
  const base = git(dir, ["merge-base", "HEAD", `origin/${defaultBranch}`]);
  return { dir, repo, branch, defaultBranch, base };
}

export function changedPaths(dir, base, includeWorkingTree) {
  if (!base) return [];
  const committed = git(dir, ["diff", "--name-only", base, "HEAD"]).split("\n");
  const working = includeWorkingTree ? git(dir, ["diff", "--name-only", "HEAD"]).split("\n").concat(git(dir, ["diff", "--name-only", "--cached"]).split("\n")) : [];
  return [...new Set([...committed, ...working].filter(Boolean))].slice(0, 400);
}

async function call(path, init = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "cf-access-client-id": ID, "cf-access-client-secret": SECRET, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`lockkeeper ${res.status}`);
  return res;
}

/** The directory a Bash command runs git in: `git -C <dir>`, or a leading `cd <dir> &&`. */
export function commandDir(command, cwd) {
  const c = /\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const cdm = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(command);
  const pick = (m) => (m ? m[2] ?? m[3] ?? m[4] : null);
  const dir = pick(c) ?? pick(cdm);
  if (!dir) return cwd;
  return dir.startsWith("/") ? dir : join(cwd, dir);
}

export function gitVerb(command) {
  const m = /\bgit\b(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+(commit|push)\b/.exec(command);
  return m ? m[1] : null;
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

async function sessionStart(input) {
  const cwd = input.cwd ?? process.cwd();
  let dirs = [cwd];
  if (!existsSync(join(cwd, ".git"))) {
    // A cloud session starts above the clones: brief each repository beside it.
    dirs = readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(cwd, d.name, ".git")))
      .map((d) => join(cwd, d.name))
      .slice(0, 12);
  }
  const parts = [];
  for (const dir of dirs) {
    const s = repoState(dir);
    if (!s) continue;
    const q = new URLSearchParams({ repo: s.repo });
    if (s.branch && s.branch !== "HEAD" && s.branch !== s.defaultBranch) q.set("branch", s.branch);
    const paths = changedPaths(dir, s.base, true);
    if (paths.length) q.set("paths", paths.join(","));
    try {
      const text = await (await call(`/v1/brief?${q}`)).text();
      // With several repositories, only those with something to say.
      if (dirs.length > 1 && text.includes("Nothing in flight near your work.") && !text.includes("Landed on")) continue;
      parts.push(text.slice(0, dirs.length > 1 ? 1800 : MAX_CONTEXT));
    } catch {
      // Lockkeeper unreachable: say nothing.
    }
  }
  if (!parts.length) return;
  parts.push("When you know which paths you will change, call the Lockkeeper `claim` tool with them and a one-line goal; call `check` before a commit or push.");
  process.stdout.write(parts.join("\n\n").slice(0, MAX_CONTEXT));
}

async function preTool(input) {
  const command = input.tool_input?.command ?? "";
  const verb = gitVerb(command);
  if (!verb) return;
  const dir = commandDir(command, input.cwd ?? process.cwd());
  const s = repoState(dir);
  if (!s || !s.base) return;
  const paths = changedPaths(dir, s.base, verb === "commit");
  let result;
  try {
    result = await (await call("/v1/check", { method: "POST", body: JSON.stringify({ repo: s.repo, base: s.base, paths, branch: s.branch }) })).json();
  } catch {
    return;
  }
  if (verb === "push" && result.collisions?.length && process.env.LOCKKEEPER_PUSH === "hold-once") {
    const key = createHash("sha256").update(`${s.repo}\n${s.branch}\n${git(dir, ["rev-parse", "HEAD"])}\n${result.head}`).digest("hex").slice(0, 16);
    const mark = join(tmpdir(), `lockkeeper-held-${key}`);
    if (!existsSync(mark)) {
      writeFileSync(mark, new Date().toISOString());
      out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${result.text}\n(Held once by Lockkeeper; the same push again goes through.)` } });
      return;
    }
  }
  if (result.behind === 0 && !(result.near ?? []).length) return; // nothing to say
  out({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: String(result.text).slice(0, MAX_CONTEXT) } });
}

async function main() {
  if (!URL_BASE || !ID || !SECRET) return; // not configured on this machine
  const input = await readStdin();
  const mode = process.argv[2];
  if (mode === "session-start") await sessionStart(input);
  else if (mode === "pre-tool") await preTool(input);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => undefined).finally(() => process.exit(0));
}
