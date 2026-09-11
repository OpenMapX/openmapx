import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerCoverageEvidenceRoute } from "../../src/coverage/api.js";
import { CoverageSnapshotStore } from "../../src/coverage/snapshot-store.js";
import type { DataManagerCoverageSnapshot } from "../../src/coverage/types.js";

const snapshot: DataManagerCoverageSnapshot = {
  schemaVersion: 1,
  snapshotId: "",
  generatedAt: "2026-09-10T12:00:00.000Z",
  collectionStatus: "complete",
  authorities: [
    { authority: "data-manager", status: "available", observedAt: "2026-09-10T12:00:00.000Z" },
  ],
  warnings: [],
  regions: [{ key: "country:DE", label: "Germany", kind: "country" }],
  streams: [],
  totalStreams: 0,
  truncated: false,
  unassignedSourceCount: 0,
};

describe("GET /coverage/evidence", () => {
  it("returns a private immutable page and pins its snapshot", async () => {
    const app = Fastify({ logger: false });
    const store = new CoverageSnapshotStore({ collect: async () => snapshot });
    registerCoverageEvidenceRoute(app, {
      dataDir: "/tmp/unused",
      sql: {} as never,
      stateStore: {} as never,
      snapshotStore: store,
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/coverage/evidence?limit=1" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      collectionStatus: "complete",
      pagination: { offset: 0, limit: 1, snapshotId: expect.any(String) },
    });
    await app.close();
  });

  it("rejects malformed bounds and expired snapshot ids", async () => {
    const app = Fastify({ logger: false });
    const store = new CoverageSnapshotStore({ collect: async () => snapshot });
    registerCoverageEvidenceRoute(app, {
      dataDir: "/tmp/unused",
      sql: {} as never,
      stateStore: {} as never,
      snapshotStore: store,
    });
    await app.ready();

    const malformed = await app.inject({ method: "GET", url: "/coverage/evidence?limit=101" });
    expect(malformed.statusCode).toBe(400);
    const expired = await app.inject({
      method: "GET",
      url: "/coverage/evidence?snapshotId=missing-revision",
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toEqual({ error: "snapshot_expired" });
    await app.close();
  });
});
