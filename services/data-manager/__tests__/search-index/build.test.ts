import { describe, expect, it, vi } from "vitest";
import {
  buildOsmSearchIndex,
  deduplicateSearchPlaces,
  validateSearchIndexCounts,
} from "../../src/jobs/search-index/build.js";

describe("buildOsmSearchIndex", () => {
  it("scrubs a build failure before storing or exposing durable diagnostics", async () => {
    const persisted: unknown[][] = [];
    let failed = false;
    const unsafe = vi.fn(async (query: string, params?: unknown[]) => {
      if (!failed && query.includes("osm_search__staging")) {
        failed = true;
        throw new Error(
          "download https://search-user:SEARCH-PASSWORD@example.org/data?token=SEARCH-TOKEN failed",
        );
      }
      if (query.includes("to_regclass")) return [{ exists: true }];
      if (query.includes("SET last_error")) persisted.push(params ?? []);
      return [];
    });
    const runtimeState = { building: false, failure: null };

    await expect(
      buildOsmSearchIndex({
        region: "europe/germany",
        dataDir: "/data",
        store: {
          getAll: () => [
            {
              type: "osm-pbf",
              id: "europe/germany",
              sizeBytes: 0,
              downloadedAt: "2026-08-21T00:00:00.000Z",
              path: "/dev/null",
            },
          ],
        } as never,
        sql: { unsafe } as never,
        runtimeState,
        operationLock: { run: (work: () => Promise<unknown>) => work() } as never,
      }),
    ).rejects.toThrow("[resolve] download https://example.org/data failed");

    expect(persisted).toEqual([["[resolve] download https://example.org/data failed"]]);
    expect(runtimeState.failure).toMatchObject({
      region: "europe/germany",
      error: "[resolve] download https://example.org/data failed",
    });
    const serialized = JSON.stringify({ persisted, runtimeState });
    expect(serialized).toContain("example.org");
    expect(serialized).not.toMatch(/SEARCH-PASSWORD|SEARCH-TOKEN|search-user/);
  });

  it("rejects an absent region before changing the database", async () => {
    const unsafe = vi.fn();
    await expect(
      buildOsmSearchIndex({
        region: "europe/germany",
        dataDir: "/data",
        store: { getAll: () => [] } as never,
        sql: { unsafe } as never,
        runtimeState: { building: false, failure: null },
      }),
    ).rejects.toThrow(/no registered OSM PBF/);
    expect(unsafe).not.toHaveBeenCalled();
  });

  it("rejects empty and internally inconsistent staged snapshots", () => {
    expect(() =>
      validateSearchIndexCounts({ places: 0, terms: 1, orphans: 0, invalid: 0 }),
    ).toThrow(/places/);
    expect(() =>
      validateSearchIndexCounts({ places: 1, terms: 1, orphans: 1, invalid: 0 }),
    ).toThrow(/orphan/);
    expect(() =>
      validateSearchIndexCounts({ places: 2, terms: 3, orphans: 0, invalid: 0 }),
    ).not.toThrow();
  });

  it("deduplicates repeated OSM objects and term primary keys before bulk insertion", () => {
    const base = {
      osmType: "node" as const,
      osmId: "1",
      name: "Airport",
      lat: 1,
      lng: 2,
      category: "aeroway:aerodrome",
      tags: { name: "Airport" },
      importance: 0.9,
      terms: [
        {
          normalizedTerm: "abc",
          displayValue: "ABC",
          kind: "authoritative_code" as const,
          namespace: "iata",
        },
        {
          normalizedTerm: "abc",
          displayValue: "ABC",
          kind: "authoritative_code" as const,
          namespace: "icao",
        },
      ],
    };
    const result = deduplicateSearchPlaces([base, { ...base, name: "Latest Airport" }]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Latest Airport");
    expect(result[0].terms).toHaveLength(1);
  });
});
