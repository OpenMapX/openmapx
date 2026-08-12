import { describe, expect, it, vi } from "vitest";
import {
  buildOsmSearchIndex,
  deduplicateSearchPlaces,
  validateSearchIndexCounts,
} from "../../src/jobs/search-index/build.js";

describe("buildOsmSearchIndex", () => {
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
