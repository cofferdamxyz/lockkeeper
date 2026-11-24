// node --test claude-code/mcp-stdio.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "mcp-stdio.mjs");

/** Runs the proxy with `env` (and nothing inherited that names Lockkeeper), feeds it lines, returns what it wrote. */
function run(env, lines) {
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LOCKKEEPER_")));
    const child = spawn(process.execPath, [PROXY], { env: { ...clean, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    for (const l of lines) child.stdin.write(JSON.stringify(l) + "\n");
    child.stdin.end();
  });
}

const request = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const notification = { jsonrpc: "2.0", method: "notifications/initialized" };

test("without LOCKKEEPER_URL it answers with an error and sends the token nowhere", async () => {
  // The error is the proof: it is written before any request is built. (That no host is written
  // into the proxy to fall back to is the guard test's job, worker/test/guard.test.ts.)
  const out = await run({ LOCKKEEPER_ACCESS_CLIENT_ID: "id", LOCKKEEPER_ACCESS_CLIENT_SECRET: "secret" }, [request, notification, [request, { ...request, id: 2 }]]);
  assert.deepEqual(out.map((m) => m.id), [1, 1, 2]); // the request, then the batch's two; nothing for the notification
  for (const m of out) {
    assert.equal(m.error.code, -32000);
    assert.match(m.error.message, /LOCKKEEPER_URL/);
  }
});

test("with a URL it forwards to that host alone, with the service token", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, id: req.headers["cf-access-client-id"], secret: req.headers["cf-access-client-secret"] });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await run({ LOCKKEEPER_URL: `http://127.0.0.1:${server.address().port}/`, LOCKKEEPER_ACCESS_CLIENT_ID: "id", LOCKKEEPER_ACCESS_CLIENT_SECRET: "secret" }, [request]);
    assert.deepEqual(out, [{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
    assert.deepEqual(seen, [{ url: "/mcp", id: "id", secret: "secret" }]);
  } finally {
    server.close();
  }
});

test("without the service token it answers with an error and makes no request", async () => {
  let hits = 0;
  const server = createServer((_, res) => (hits++, res.end("{}")));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await run({ LOCKKEEPER_URL: `http://127.0.0.1:${server.address().port}` }, [request]);
    assert.equal(out[0].error.code, -32000);
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});

test("a plain-http URL that is not this machine counts as unset", async () => {
  const out = await run({ LOCKKEEPER_URL: "http://lockkeeper.invalid", LOCKKEEPER_ACCESS_CLIENT_ID: "id", LOCKKEEPER_ACCESS_CLIENT_SECRET: "secret" }, [request]);
  assert.equal(out[0].error.code, -32000);
  const withUser = await run({ LOCKKEEPER_URL: "https://user:pw@lockkeeper.invalid", LOCKKEEPER_ACCESS_CLIENT_ID: "id", LOCKKEEPER_ACCESS_CLIENT_SECRET: "secret" }, [request]);
  assert.equal(withUser[0].error.code, -32000);
});

test("it never follows a redirect, which would carry the token to another host", async () => {
  const elsewhere = [];
  const other = createServer((req, res) => (elsewhere.push(req.headers["cf-access-client-secret"]), res.end("{}")));
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const server = createServer((_, res) => {
    res.statusCode = 302;
    res.setHeader("location", `http://127.0.0.1:${other.address().port}/mcp`);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await run({ LOCKKEEPER_URL: `http://127.0.0.1:${server.address().port}`, LOCKKEEPER_ACCESS_CLIENT_ID: "id", LOCKKEEPER_ACCESS_CLIENT_SECRET: "secret" }, [request]);
    assert.equal(out[0].error.code, -32001); // unreachable, as far as the session is told
    assert.deepEqual(elsewhere, []);
  } finally {
    server.close();
    other.close();
  }
});
