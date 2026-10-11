#!/usr/bin/env node
// Preview the built dashboard (./out) locally against a deployed Lockkeeper.
// Serves the static export and forwards /api/* to the Worker, adding the dashboard token
// from a file, so the real token never enters the browser. Dev convenience only.
//
//   node dashboard/dev-proxy.mjs --upstream https://<worker>.workers.dev --token-file ./secrets.env [--port 8788]
//
// The token file is either "TOKEN=value" lines (the first *TOKEN= line wins) or the bare token.
import { createServer } from "node:http";
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

createServer(async (req, res) => {
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
  if (!existsSync(file)) file = join(root, "index.html");
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`dashboard preview on http://localhost:${port} → ${upstream}`));
