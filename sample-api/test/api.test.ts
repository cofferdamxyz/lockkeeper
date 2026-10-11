import { beforeEach, describe, expect, it } from "vitest";

import app, { berths } from "../src/index";

beforeEach(() => {
  berths[0].vessel = "MV Aurora";
  berths[1].vessel = null;
  berths[2].vessel = "MV Cerulean";
});

describe("harbor api", () => {
  it("lists berths", async () => {
    const res = await app.request("/berths");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { berths: unknown[] };
    expect(body.berths).toHaveLength(3);
  });

  it("moors a vessel at a free berth and refuses an occupied one", async () => {
    const ok = await app.request("/berths/b2/moor", { method: "POST", body: JSON.stringify({ vessel: "MV Tide" }), headers: { "content-type": "application/json" } });
    expect(ok.status).toBe(200);
    const busy = await app.request("/berths/b1/moor", { method: "POST", body: JSON.stringify({ vessel: "MV Tide" }), headers: { "content-type": "application/json" } });
    expect(busy.status).toBe(409);
  });

  it("returns 404 for an unknown berth", async () => {
    const res = await app.request("/berths/nope");
    expect(res.status).toBe(404);
  });
});
