import { describe, expect, it, vi } from "vitest";
import { createPoiSearchOrchestrator } from "../orchestrator";
import type { PoiSearchProvider } from "../types";

const bbox = { south: 52.5, west: 13.4, north: 52.6, east: 13.5 };

function makeCtx(provider: PoiSearchProvider) {
  return {
    getIntegrationsByDomain: () => [{ providers: new Map([["poi-search", [provider]]]) }],
  } as unknown as Parameters<typeof createPoiSearchOrchestrator>[0];
}

describe("orchestrator preset: dispatch", () => {
  it("routes category=preset:<id> through the preset path with derived OSM tags", async () => {
    const calls: Array<{ category: string; opts: unknown }> = [];
    const provider: PoiSearchProvider = {
      id: "fake-overpass",
      categories: ["__preset__"],
      search: vi.fn(async (category, _bbox, opts) => {
        calls.push({ category, opts });
        return [];
      }),
    };
    const orch = createPoiSearchOrchestrator(makeCtx(provider));

    const out = await orch.search("preset:amenity/ice_cream", bbox);
    expect(out.results).toEqual([]);
    expect(provider.search).toHaveBeenCalled();
    // The orchestrator translates "preset:<id>" to the "__preset__" sentinel before
    // dispatching, so providers see a stable category string regardless of preset id.
    expect(calls[0].category).toBe("__preset__");
    const opts = calls[0].opts as { osmTags?: Record<string, string> };
    expect(opts.osmTags).toEqual({ amenity: "ice_cream" });
  });

  it("returns 400-shaped error for unknown preset id", async () => {
    const provider: PoiSearchProvider = {
      id: "fake-overpass",
      categories: ["__preset__"],
      search: vi.fn(),
    };
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    await expect(orch.search("preset:nonexistent/foo", bbox)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("falls back to the existing provider lookup for non-preset categories", async () => {
    const provider: PoiSearchProvider = {
      id: "fake-overpass",
      categories: ["restaurants"],
      search: vi.fn(async () => []),
    };
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    const out = await orch.search("restaurants", bbox);
    expect(out.results).toEqual([]);
    expect(provider.search).toHaveBeenCalledWith(
      "restaurants",
      expect.any(Object),
      expect.objectContaining({ osmTags: undefined }),
    );
  });

  it("returns 400 when category is missing or non-string instead of throwing", async () => {
    const provider: PoiSearchProvider = {
      id: "fake-overpass",
      categories: ["restaurants"],
      search: vi.fn(),
    };
    const orch = createPoiSearchOrchestrator(makeCtx(provider));
    await expect(orch.search(undefined as unknown as string, bbox)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(orch.search("" as string, bbox)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
