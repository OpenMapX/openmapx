import type { OverpassFilter } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { createPoiSearchOrchestrator } from "../orchestrator";
import type { PoiSearchProvider } from "../types";

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
