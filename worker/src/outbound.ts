import { WorkerEntrypoint } from "cloudflare:workers";

import { getToken } from "./db";
import { artifactsHost, GATEWAY_HOST, type LockkeeperEnv, NPM_HOST } from "./env";

export interface OutboundProps {
  /** The sandbox name this gateway serves; tokens are looked up by it. */
  sandbox: string;
}

/**
 * Every HTTP request a sandbox makes arrives here (ports 80 and 443 only; the container has no
 * other route). Three hosts are allowed. Credentials are added here and never enter the sandbox:
 * the AI Gateway token, and the Artifacts repository token minted for this sandbox.
 */
export class Outbound extends WorkerEntrypoint<LockkeeperEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") {
      return new Response(`${url.hostname} is reachable only over HTTPS\n`, { status: 403 });
    }
    const props = ((this.ctx as unknown as { props?: Partial<OutboundProps> }).props ?? {}) as Partial<OutboundProps>;

    if (url.hostname === GATEWAY_HOST && this.#isGatewayPath(url.pathname)) {
      const headers = new Headers(request.headers);
      headers.delete("x-api-key");
      headers.set("cf-aig-authorization", `Bearer ${this.env.AI_GATEWAY_TOKEN}`);
      if (props.sandbox) headers.set("cf-aig-metadata", JSON.stringify({ sandbox: props.sandbox }));
      return fetch(new Request(request, { headers }));
    }

    if (url.hostname === artifactsHost(this.env)) {
      const m = /^\/git\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/.exec(url.pathname);
      if (!m || m[1] !== this.env.ARTIFACTS_NAMESPACE) {
        return new Response("repository is outside this deployment's namespace\n", { status: 403 });
      }
      if (!props.sandbox) return new Response("no sandbox identity\n", { status: 403 });
      const token = await getToken(this.env.DB, props.sandbox, m[2]);
      if (!token) return new Response(`no token for ${m[2]} in this sandbox\n`, { status: 403 });
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(new Request(request, { headers }));
    }

    if (url.hostname === NPM_HOST) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("the registry is read-only from a sandbox\n", { status: 403 });
      }
      return fetch(request);
    }

    return new Response(`${url.hostname} is not reachable from this sandbox\n`, { status: 403 });
  }

  #isGatewayPath(pathname: string): boolean {
    const gatewayPath = `/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}`;
    return pathname === gatewayPath || pathname.startsWith(`${gatewayPath}/`);
  }
}
