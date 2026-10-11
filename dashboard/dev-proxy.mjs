#!/usr/bin/env node
// Preview the built dashboard (./out) locally against a deployed Lockkeeper.
// Serves the static export and forwards /api/* to the Worker, adding the dashboard token
// from a file, so the real token never enters the browser. Dev convenience only.
//
//   node dashboard/dev-proxy.mjs --upstream https://<worker>.workers.dev --token-file ./secrets.env [--port 8788]
//
// The token file is either "TOKEN=value" lines (the first *TOKEN= line wins) or the bare token.
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const upstream = opt("--upstream", process.env.LOCKKEEPER_URL);
const tokenFile = opt("--token-file", process.env.LOCKKEEPER_TOKEN_FILE);
const port = Number(opt("--port", "8788"));
if (!upstream || !tokenFile) {
  console.error("usage: dev-proxy.mjs --upstream <url> --token-file <file> [--port 8788]");
  process.exit(2);
}
const raw = readFileSync(tokenFile, "utf8");
const line = raw.split("\n").find((l) => /TOKEN=/.test(l) && !l.trim().startsWith("#"));
const token = (line ? line.split("=").slice(1).join("=") : raw).trim();
const root = join(dirname(fileURLToPath(import.meta.url)), "out");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });
    const headers = { authorization: `Bearer ${token}` };
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    try {
      const r = await fetch(upstream + url.pathname + url.search, { method: req.method, headers, body });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`upstream error: ${e}`);
    }
    return;
  }
  let file = join(root, decodeURIComponent(url.pathname));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    // A build renames its chunks; a stale page asking for an old one must see a 404, not the app shell.
    if (url.pathname.startsWith("/_next/")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    file = join(root, "index.html");
  }
  const type = types[extname(file)] ?? "application/octet-stream";
  // The shell must never be cached, or a rebuild leaves the browser pointing at chunks that are gone.
  res.writeHead(200, { "content-type": type, "cache-control": type.startsWith("text/html") ? "no-store" : "public, max-age=3600" });
  res.end(readFileSync(file));
});

// The live feed is a WebSocket; pipe the upgrade to the Worker as-is (the ticket in the URL is its auth).
const up = new URL(upstream);
server.on("upgrade", (req, socket, head) => {
  const tls = up.protocol === "https:";
  const conn = (tls ? tlsConnect : netConnect)({ host: up.hostname, port: Number(up.port) || (tls ? 443 : 80), servername: up.hostname });
  conn.once(tls ? "secureConnect" : "connect", () => {
    const headers = { ...req.headers, host: up.host };
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`), "", ""];
    conn.write(lines.join("\r\n"));
    if (head.length) conn.write(head);
    conn.pipe(socket);
    socket.pipe(conn);
  });
  conn.on("error", () => socket.destroy());
  socket.on("error", () => conn.destroy());
});
server.listen(port, () => console.log(`dashboard preview on http://localhost:${port} → ${upstream}`));
