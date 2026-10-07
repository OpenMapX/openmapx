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
