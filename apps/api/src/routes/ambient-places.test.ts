import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ role: "user" }));
afterEach(() => {
  session.role = "user";
  vi.unstubAllGlobals();
});
vi.mock("../db/index.js", () => ({ sql: {} }));
vi.mock("../auth.js", () => ({
  auth: {
    api: { getSession: async () => ({ user: { role: session.role, id: "fixture-admin" } }) },
  },
}));
vi.mock("../utils/rate-limit.js", () => ({
  systemMaintenanceLimit: { preHandler: () => async () => {} },
}));
vi.mock("../utils/audit-log.js", () => ({ writeAuditLog: vi.fn() }));

import { ambientPlacesRoute } from "./ambient-places";

const generation = "11111111-1111-4111-8111-111111111111";
const path = `/ambient-places/tiles/${generation}/16/33874/22001.mvt`;

describe("ambient HTTP budgets", () => {
  it("uses no-store discovery and immutable generation URLs", async () => {
    const app = Fastify();
    await app.register(ambientPlacesRoute, {
      readManifest: async () => null,
      readTile: async () => Buffer.from("tile"),
    });
    const manifest = await app.inject("/ambient-places/manifest");
    expect(manifest.json()).toEqual({ manifest: null });
    expect(manifest.headers["cache-control"]).toBe("no-store");
    const tile = await app.inject(path);
    expect(tile.statusCode).toBe(200);
    expect(tile.headers["cache-control"]).toContain("immutable");
    expect(tile.headers["content-type"]).toContain("application/vnd.mapbox-vector-tile");
    await app.close();
  });
  it("rejects invalid generation and XYZ before querying", async () => {
    const read = vi.fn();
    const app = Fastify();
    await app.register(ambientPlacesRoute, { readTile: read });
    for (const p of [
      path.replace(generation, "invalid"),
      path.replace("/16/", "/12/"),
      path.replace("/33874/", "/999999/"),
      path.replace("/33874/", "/-1/"),
    ])
      expect((await app.inject(p)).statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
    await app.close();
  });
  it("does not cache unknown, oversized or failed tiles and rejects public admin access", async () => {
    const app = Fastify();
    const read = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Buffer.alloc(131073))
      .mockRejectedValueOnce(new Error("private database detail"));
    await app.register(ambientPlacesRoute, { readTile: read });
    expect((await app.inject(path)).statusCode).toBe(404);
    for (let i = 0; i < 2; i++) {
      const r = await app.inject(path);
      expect(r.statusCode).toBe(503);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.body).not.toContain("private database");
    }
    expect(
      (await app.inject({ method: "POST", url: "/admin/ambient-places/build", payload: {} }))
        .statusCode,
    ).toBe(403);
    await app.close();
  });
  it("validates administrator publication bounds before sending a request to data-manager", async () => {
    session.role = "admin";
    const proxy = vi.fn(
      async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    vi.stubGlobal("fetch", proxy);
    const app = Fastify();
    await app.register(ambientPlacesRoute, {});
    const bad = await app.inject({
      method: "POST",
      url: "/admin/ambient-places/build",
      payload: { name: "Planet", bounds: [-180, -90, 180, 90] },
    });
    expect(bad.statusCode).toBe(400);
    expect(proxy).not.toHaveBeenCalled();
    const good = await app.inject({
      method: "POST",
      url: "/admin/ambient-places/build",
      payload: { name: "Aachen", bounds: [5.9, 50.65, 6.3, 50.95] },
    });
    expect(good.statusCode).toBe(202);
    expect(proxy).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it("bounds concurrent tile reads and releases permits after failure", async () => {
    const app = Fastify();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const read = vi.fn(async () => {
      await gate;
      throw new Error("offline");
    });
    await app.register(ambientPlacesRoute, { readTile: read });
    const requests = Array.from({ length: 9 }, () => app.inject(path));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(8));
    release();
    const responses = await Promise.all(requests);
    expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(1);
    expect((await app.inject(path)).statusCode).toBe(503);
    expect(read).toHaveBeenCalledTimes(9);
    await app.close();
  });
});
