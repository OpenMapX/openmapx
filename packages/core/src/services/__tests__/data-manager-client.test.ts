import { describe, expect, it, vi } from "vitest";
import { DataManagerClient } from "../data-manager-client";

describe("DataManagerClient transit source lifecycle", () => {
  it("reads bounded coverage evidence with the pinned snapshot and auth token", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://data-manager.test/coverage/evidence?snapshotId=revision-1&offset=100&limit=100",
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({
        schemaVersion: 1,
        snapshotId: "revision-1",
        generatedAt: "2026-09-10T12:00:00.000Z",
        evaluatedAt: "2026-09-10T12:00:00.000Z",
        collectionStatus: "complete",
        authorities: [],
        warnings: [],
        regions: [],
        evidence: [],
        total: 0,
        retainedTotal: 0,
        truncated: false,
        unassignedSourceCount: 0,
        pagination: { offset: 100, limit: 100, total: 0, hasMore: false, snapshotId: "revision-1" },
      });
    });
    const client = new DataManagerClient({
      baseUrl: "https://data-manager.test",
      authToken: "secret",
      fetch,
    });

    await expect(
      client.coverageEvidence({ snapshotId: "revision-1", offset: 100, limit: 100 }),
    ).resolves.toMatchObject({ snapshotId: "revision-1", pagination: { offset: 100 } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves data-manager HTTP status for expired evidence revisions", async () => {
    const client = new DataManagerClient({
      baseUrl: "https://data-manager.test",
      fetch: async () => Response.json({ error: "snapshot_expired" }, { status: 409 }),
    });
    await expect(client.coverageEvidence({ snapshotId: "revision-1" })).rejects.toMatchObject({
      name: "DataManagerHttpError",
      status: 409,
      message: "snapshot_expired",
    });
  });

  it("starts transactional syncs and source mutations through lifecycle endpoints", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new DataManagerClient({
      baseUrl: "https://data-manager.test",
      authToken: "secret",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ jobId: "job-1", sourceId: "de-test", status: "started" });
      },
    });

    await client.syncTransit({ countries: ["de"] });
    await client.addTransitSource({
      region: "de",
      name: "Test transit",
      url: "https://example.com/test.zip",
      license: { spdxIdentifier: "CC-BY-4.0", attribution: "Test Transit" },
    });
    await client.removeTransitSource("de-test");
    await client.enableTransitSource("de-test");

    expect(requests).toEqual([
      {
        url: "https://data-manager.test/transit/sync",
        method: "POST",
        body: { countries: ["de"] },
      },
      {
        url: "https://data-manager.test/transit/sources",
        method: "POST",
        body: {
          region: "de",
          name: "Test transit",
          url: "https://example.com/test.zip",
          license: { spdxIdentifier: "CC-BY-4.0", attribution: "Test Transit" },
        },
      },
      {
        url: "https://data-manager.test/transit/sources/de-test",
        method: "DELETE",
        body: {},
      },
      {
        url: "https://data-manager.test/transit/sources/de-test/enable",
        method: "POST",
        body: {},
      },
    ]);
  });

  it("surfaces a single-flight conflict reason", async () => {
    const client = new DataManagerClient({
      baseUrl: "https://data-manager.test",
      fetch: async () =>
        Response.json({ error: "sync already running", reason: "job-active" }, { status: 409 }),
    });

    await expect(client.syncTransit()).rejects.toThrow("sync already running");
  });
});
