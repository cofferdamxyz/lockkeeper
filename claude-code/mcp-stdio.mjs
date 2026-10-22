#!/usr/bin/env node
// A stdio MCP server that forwards to Lockkeeper's HTTP MCP endpoint (DESIGN.md §13 step 2).
//
// Claude Code can talk to an HTTP MCP server directly, but its headers must then be literal or
// come from the process environment, and a desktop-app session has no shell that loaded the
// workspace .envrc. This proxy runs under `direnv exec <workspace>` instead, so the Access service
// token is read from .envrc at start and never stored in a settings file.
//
// Wire format: one JSON-RPC message per line on stdin, one per line on stdout. Each request is
// POSTed to $LOCKKEEPER_URL/mcp with the service-token headers; the Worker is stateless and
// answers a request with JSON and a notification with 202. No dependencies; Node 18 or newer.
//
// Environment: LOCKKEEPER_URL, LOCKKEEPER_ACCESS_CLIENT_ID, LOCKKEEPER_ACCESS_CLIENT_SECRET.

import { createInterface } from "node:readline";

const URL_BASE = (process.env.LOCKKEEPER_URL ?? "https://lockkeeper.cofferdam.xyz").replace(/\/+$/, "");
const ID = process.env.LOCKKEEPER_ACCESS_CLIENT_ID ?? "";
const SECRET = process.env.LOCKKEEPER_ACCESS_CLIENT_SECRET ?? "";
const TIMEOUT_MS = Number(process.env.LOCKKEEPER_TIMEOUT_MS ?? 15000);

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function errorFor(msg, code, text) {
  const ids = Array.isArray(msg) ? msg.map((m) => m?.id).filter((id) => id !== undefined && id !== null) : [msg?.id];
  return ids.filter((id) => id !== undefined && id !== null).map((id) => ({ jsonrpc: "2.0", id, error: { code, message: text } }));
}

async function forward(msg) {
  if (!ID || !SECRET) {
    for (const e of errorFor(msg, -32000, "Lockkeeper is not configured: LOCKKEEPER_ACCESS_CLIENT_ID and LOCKKEEPER_ACCESS_CLIENT_SECRET are missing")) write(e);
    return;
  }
  let res;
  try {
    res = await fetch(`${URL_BASE}/mcp`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "cf-access-client-id": ID,
        "cf-access-client-secret": SECRET,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(msg),
    });
  } catch (err) {
    for (const e of errorFor(msg, -32001, `Lockkeeper unreachable: ${err?.cause?.code ?? err?.name ?? "error"}`)) write(e);
    return;
  }
  if (res.status === 202 || res.status === 204) return; // a notification, nothing to answer
  const text = await res.text();
  if (!res.ok) {
    for (const e of errorFor(msg, -32002, `Lockkeeper answered ${res.status}`)) write(e);
    return;
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) for (const m of parsed) write(m);
    else write(parsed);
  } catch {
    for (const e of errorFor(msg, -32003, "Lockkeeper answered with something that is not JSON")) write(e);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  chain = chain.then(() => forward(msg)).catch(() => undefined);
});
rl.on("close", () => {
  chain.finally(() => process.exit(0));
});
