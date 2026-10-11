import { DurableObject } from "cloudflare:workers";

import type { LockkeeperEnv } from "./env";

/**
 * One hub per project fans Lockkeeper's events out to every open dashboard over WebSocket.
 * Browsers cannot send a bearer header on a WebSocket, so a dashboard first asks the Worker
 * (authenticated) for a one-minute, single-use ticket and connects with that. The hub keeps
 * no history: a message means "something changed, fetch the state"; the payload says what.
 */
export class LiveHub extends DurableObject<LockkeeperEnv> {
  constructor(ctx: DurableObjectState, env: LockkeeperEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async ticket(): Promise<string> {
    const id = crypto.randomUUID();
    await this.ctx.storage.put(`ticket:${id}`, Date.now() + 60_000);
    return id;
  }

  async broadcast(message: string): Promise<number> {
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
        sent++;
      } catch {
        // closed between the list and the send
      }
    }
    return sent;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/connect") return new Response("not found", { status: 404 });
    const ticket = url.searchParams.get("ticket") ?? "";
    const key = `ticket:${ticket}`;
    const expires = ticket ? await this.ctx.storage.get<number>(key) : undefined;
    if (ticket) await this.ctx.storage.delete(key);
    if (!expires || expires < Date.now()) return new Response("bad ticket", { status: 403 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "closed");
    } catch {
      // already closed
    }
  }
}

export type LiveEvent =
  | { type: "task"; task: string; status: string }
  | { type: "push"; task?: string; ref?: string; sha?: string | null }
  | { type: "merge"; task: string; mode: string }
  | { type: "lock" }
  | { type: "index" };

/** Tell every open dashboard for a project that something changed. Never throws. */
export async function notify(env: LockkeeperEnv, project: string, event: LiveEvent): Promise<void> {
  try {
    if (!env.LIVE) return;
    await env.LIVE.getByName(`live-${project}`).broadcast(JSON.stringify({ ...event, project, at: new Date().toISOString() }));
  } catch (e) {
    console.warn("notify failed", String(e));
  }
}
