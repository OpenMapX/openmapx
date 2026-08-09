import type { OverpassFilter, TagPredicate } from "@openmapx/core";
import { MAX_POI_SEARCH_RESULTS, OverpassTimeoutError } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { createPoiSearchOrchestrator } from "../orchestrator";
import type { PoiSearchProvider, PoiSearchResult } from "../types";

const bbox = { south: 52.5, west: 13.4, north: 52.6, east: 13.5 };

const validFilter: OverpassFilter = {
  selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }],
  elementTypes: ["node", "way"],
};

function makeCtx(provider: PoiSearchProvider) {
  return {
    getIntegrationsByDomain: () => [{ providers: new Map([["poi-search", [provider]]]) }],
  } as unknown as Parameters<typeof createPoiSearchOrchestrator>[0];
}

const WIFI: TagPredicate = { key: "internet_access", op: "=", value: "wlan" };
const OUTDOOR: TagPredicate = { key: "outdoor_seating", op: "=", value: "yes" };

function fakeResults(n: number): PoiSearchResult[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `osm:node/${i}`,
    name: `Place ${i}`,
    coordinates: [13.45, 52.55] as [number, number],
  }));
}

// Provider whose result count is a function of how many `require` predicates the
// incoming filter still has — lets us drive the relaxation loop deterministically.
function makeCountingProvider(countFor: (requireLen: number) => number): PoiSearchProvider {
  return {
    id: "fake-overpass",
    categories: [],
    search: vi.fn(),
    searchByFilter: vi.fn(async (filter: OverpassFilter) =>
      fakeResults(countFor(filter.require?.length ?? 0)),
    ),
  };
}

function filterWithRequire(require: TagPredicate[]): OverpassFilter {
  return {
    selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }],
    require,
    elementTypes: ["node", "way"],
  };
}

describe("orchestrator searchByFilter", () => {
  it("dispatches to provider.searchByFilter, enriches openingHoursInfo, and returns partial=false", async () => {
    const provider: PoiSearchProvider = {
      id: "fake-overpass",
      categories: [],
      search: vi.fn(),
      searchByFilter: vi.fn(async () => [
        {
          id: "osm:node/123",
          name: "Test Cafe",
          coordinates: [13.45, 52.55],
          openingHours: "Mo-Su 00:00-24:00",
        },
      ]),
    };
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    const result = await orch.searchByFilter(validFilter, bbox);
    expect(provider.searchByFilter).toHaveBeenCalledWith(validFilter, bbox, { lang: undefined });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].openingHoursInfo).toBeDefined();
    expect(result.partial).toBe(false);
  });

  it("rejects with statusCode 400 when no provider supports searchByFilter", async () => {
    const provider: PoiSearchProvider = {
      id: "fake-overpass",
      categories: [],
      search: vi.fn(),
    };
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    await expect(orch.searchByFilter(validFilter, bbox)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("orchestrator searchByFilter progressive relaxation", () => {
  it("does not relax when the strict filter already returns enough results", async () => {
    const provider = makeCountingProvider(() => 8);
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    const result = await orch.searchByFilter(filterWithRequire([WIFI, OUTDOOR]), bbox);
    expect(result.results).toHaveLength(8);
    expect(result.relaxed).toEqual([]);
    expect(provider.searchByFilter).toHaveBeenCalledTimes(1);
  });

  it("does not relax a filter that has no require predicates", async () => {
    const provider = makeCountingProvider(() => 1);
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    const result = await orch.searchByFilter(validFilter, bbox);
    expect(result.results).toHaveLength(1);
    expect(result.relaxed).toEqual([]);
    expect(provider.searchByFilter).toHaveBeenCalledTimes(1);
  });

  it("drops the last require predicate when too few exact matches", async () => {
    // 2 predicates → 0 results; 1 predicate → 8 results.
    const provider = makeCountingProvider((len) => (len >= 2 ? 0 : 8));
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    const result = await orch.searchByFilter(filterWithRequire([WIFI, OUTDOOR]), bbox);
    expect(result.results).toHaveLength(8);
    expect(result.relaxed).toEqual([OUTDOOR]);
    expect(provider.searchByFilter).toHaveBeenCalledTimes(2);
  });

  it("drops predicates one at a time from the end, stopping at the threshold", async () => {
    // 3 → 0, 2 → 2 (still too few), 1 → 9 (enough).
    const provider = makeCountingProvider((len) => (len >= 3 ? 0 : len === 2 ? 2 : 9));
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    const C: TagPredicate = { key: "diet:vegan", op: "=", value: "yes" };
    const result = await orch.searchByFilter(filterWithRequire([WIFI, OUTDOOR, C]), bbox);
    expect(result.results).toHaveLength(9);
    expect(result.relaxed).toEqual([C, OUTDOOR]);
    expect(provider.searchByFilter).toHaveBeenCalledTimes(3);
  });

  it("keeps the strict results and reports no relaxation when relaxing never helps", async () => {
    // Always 1 result regardless of how many predicates are dropped (sparse area).
    const provider = makeCountingProvider(() => 1);
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    const result = await orch.searchByFilter(filterWithRequire([WIFI]), bbox);
    expect(result.results).toHaveLength(1);
    expect(result.relaxed).toEqual([]);
  });
});

// Results spread across the bbox, so the spatial selection has something to
// spread — coincident points would all land in one grid cell.
function spreadResults(n: number): PoiSearchResult[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `osm:node/${i}`,
    name: `Place ${i}`,
    coordinates: [13.4 + (i % 10) * 0.01, 52.5 + Math.floor(i / 10) * 0.005] as [number, number],
  }));
}

describe("orchestrator truncation reporting", () => {
  function providerReturning(value: unknown): PoiSearchProvider {
    return {
      id: "overpass",
      categories: ["cafes"],
      search: vi.fn(async () => value),
      searchText: vi.fn(async () => value),
      searchByFilter: vi.fn(async () => value),
    } as unknown as PoiSearchProvider;
  }

  it("reports the exact total and flags truncation when the cap drops candidates", async () => {
    const over = MAX_POI_SEARCH_RESULTS + 20;
    const orch = createPoiSearchOrchestrator(makeCtx(providerReturning(spreadResults(over))));
    const result = await orch.search("cafes", bbox);
    expect(result.results).toHaveLength(MAX_POI_SEARCH_RESULTS);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(over);
  });

  it("reports no truncation when everything fits under the cap", async () => {
    const orch = createPoiSearchOrchestrator(makeCtx(providerReturning(spreadResults(12))));
    const result = await orch.search("cafes", bbox);
    expect(result).toMatchObject({ truncated: false, total: 12 });
  });

  it("omits total when the provider itself hit a ceiling, since it is only a floor", async () => {
    const provider = providerReturning({
      results: spreadResults(MAX_POI_SEARCH_RESULTS + 20),
      truncated: true,
    });
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    const result = await orch.search("cafes", bbox);
    expect(result.truncated).toBe(true);
    expect(result.total).toBeUndefined();
  });

  it("accepts a bare array from a provider that does not report truncation", async () => {
    const orch = createPoiSearchOrchestrator(makeCtx(providerReturning(spreadResults(3))));
    const result = await orch.search("cafes", bbox);
    expect(result.results).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("withholds the total after a timeout shrink, since it describes a smaller bbox", async () => {
    // First attempt times out; the retry against the shrunk bbox succeeds, so
    // the count we end up with is not a count for the requested area.
    let calls = 0;
    const provider = {
      id: "overpass",
      categories: ["cafes"],
      search: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new OverpassTimeoutError("area_too_large");
        return spreadResults(12);
      }),
    } as unknown as PoiSearchProvider;

    const result = await createPoiSearchOrchestrator(makeCtx(provider)).search("cafes", bbox);
    expect(result.partial).toBe(true);
    expect(result.total).toBeUndefined();
  });

  it("caps and reports truncation on the text path too", async () => {
    const over = MAX_POI_SEARCH_RESULTS + 30;
    const orch = createPoiSearchOrchestrator(makeCtx(providerReturning(spreadResults(over))));
    const result = await orch.searchText("cafe", bbox);
    expect(result.results).toHaveLength(MAX_POI_SEARCH_RESULTS);
    expect(result).toMatchObject({ truncated: true, total: over });
  });

  it("caps and reports truncation on the structured-filter path too", async () => {
    const over = MAX_POI_SEARCH_RESULTS + 30;
    const orch = createPoiSearchOrchestrator(makeCtx(providerReturning(spreadResults(over))));
    const result = await orch.searchByFilter(validFilter, bbox);
    expect(result.results).toHaveLength(MAX_POI_SEARCH_RESULTS);
    expect(result).toMatchObject({ truncated: true, total: over });
  });
});
