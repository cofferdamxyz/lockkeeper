import { Hono } from "hono";

/**
 * Harbor API: a small inventory of berths and the vessels moored at them. It exists so that
 * several agents can change it at once; every route is simple on purpose.
 */
export interface Berth {
  id: string;
  name: string;
  lengthM: number;
  vessel: string | null;
}

export const berths: Berth[] = [
  { id: "b1", name: "North Quay 1", lengthM: 120, vessel: "MV Aurora" },
  { id: "b2", name: "North Quay 2", lengthM: 90, vessel: null },
  { id: "b3", name: "South Pier", lengthM: 200, vessel: "MV Cerulean" },
];

const app = new Hono();

app.get("/", (c) => c.json({ name: "harbor-api", version: "0.1.0" }));

app.get("/berths", (c) => c.json({ berths }));

app.get("/berths/:id", (c) => {
  const berth = berths.find((b) => b.id === c.req.param("id"));
  if (!berth) return c.json({ error: "no such berth" }, 404);
  return c.json(berth);
});

app.post("/berths/:id/moor", async (c) => {
  const berth = berths.find((b) => b.id === c.req.param("id"));
  if (!berth) return c.json({ error: "no such berth" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { vessel?: string };
  if (!body.vessel) return c.json({ error: "vessel is required" }, 400);
  if (berth.vessel) return c.json({ error: "berth is occupied" }, 409);
  berth.vessel = body.vessel;
  return c.json(berth);
});

app.post("/berths/:id/depart", (c) => {
  const berth = berths.find((b) => b.id === c.req.param("id"));
  if (!berth) return c.json({ error: "no such berth" }, 404);
  berth.vessel = null;
  return c.json(berth);
});

export default app;
