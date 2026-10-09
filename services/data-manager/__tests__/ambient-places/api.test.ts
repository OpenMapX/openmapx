import Fastify from "fastify";
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("../../src/jobs/ambient-places/build.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildAmbientPlaces: mock.build,
  rollbackAmbientPlaces: async () => {},
  setAmbientEnabled: async () => {},
}));

import { registerAmbientPlacesApi } from "../../src/jobs/ambient-places/api.js";

describe("ambient publication job lifecycle", () => {
  it("reports staged country progress while the previous map remains active", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mock.build.mockReset();
    mock.build.mockImplementationOnce(
      async (_sql, _region, claim: () => void, options?: { onProgress: (p: unknown) => void }) => {
        claim();
        options?.onProgress({ phase: "osm", processed: 2000, batches: 1, placeCount: 1990 });
        await gate;
        return {};
      },
    );
    const sql = { unsafe: async () => [{ exists: false }] } as unknown as postgres.Sql;
    const app = Fastify();
    registerAmbientPlacesApi(app, sql);
    const response = await app.inject({
      method: "POST",
      url: "/ambient-places/build",
      payload: { name: "Germany", bounds: [5.8, 47.2, 15.1, 55.1], coverage: "germany" },
    });
    expect(response.statusCode).toBe(202);
    try {
      expect((await app.inject("/ambient-places/status")).json()).toMatchObject({
        active: null,
        building: true,
        progress: { phase: "osm", processed: 2000, batches: 1, placeCount: 1990 },
      });
    } finally {
      release();
      await app.close();
    }
  });
  it("allows retry after publisher admission fails", async () => {
    mock.build.mockRejectedValueOnce(new Error("Temporary database outage"));
    mock.build.mockImplementationOnce(async (_sql, _region, claim: () => void) => {
      claim();
      return {};
    });
    const sql = {
      begin: async (callback: (tx: { unsafe: () => Promise<unknown[]> }) => Promise<unknown>) =>
        callback({ unsafe: async () => [] }),
      unsafe: async () => {
        return [{ exists: false }];
      },
    } as unknown as postgres.Sql;
    const app = Fastify();
    registerAmbientPlacesApi(app, sql);
    const request = {
      method: "POST" as const,
      url: "/ambient-places/build",
      payload: { name: "Aachen", bounds: [5.9, 50.65, 6.3, 50.95] },
    };
    expect((await app.inject(request)).statusCode).toBe(500);
    expect((await app.inject(request)).statusCode).toBe(202);
    await app.close();
  });
});
