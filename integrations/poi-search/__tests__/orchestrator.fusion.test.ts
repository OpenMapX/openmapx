import { OverpassTimeoutError } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { createPoiSearchOrchestrator } from "../orchestrator";
import type { PoiSearchProvider, PoiSearchResult } from "../types";

const BBOX = { south: 52.49, west: 13.38, north: 52.53, east: 13.43 };

function makeCtx(
  providers: PoiSearchProvider[],
  db?: { execute: (query: string, params?: unknown[]) => Promise<unknown> },
) {
  return {
    getIntegrationsByDomain: () => [{ providers: new Map([["poi-search", providers]]) }],
    db,
  } as unknown as Parameters<typeof createPoiSearchOrchestrator>[0];
}

const OSM_RESULT_1: PoiSearchResult = {
  id: "osm:node/1",
  name: "Starbucks Mitte",
  coordinates: [13.4, 52.51],
  category: "cafes",
};

const OSM_RESULT_2: PoiSearchResult = {
  id: "osm:node/2",
  name: "Einstein Kaffee",
  coordinates: [13.42, 52.52],
  category: "cafes",
};

const OVERTURE_MATCHED: PoiSearchResult = {
  id: "overture:gers-starbucks-001",
  gersId: "gers-starbucks-001",
  name: "Starbucks Coffee",
  coordinates: [13.4, 52.51],
  category: "cafes",
  osmTags: { brand: "Starbucks", "brand:wikidata": "Q37158" },
};

const OVERTURE_EXTRA: PoiSearchResult = {
  id: "overture:gers-new-venue-999",
  gersId: "gers-new-venue-999",
  name: "Neue Kaffeebar",
  coordinates: [13.39, 52.5],
  category: "cafes",
};

const overpassProvider: PoiSearchProvider = {
  id: "overpass",
  categories: ["cafes", "restaurants", "bars", "viewpoints", "__preset__"],
  async search(_cat, _bbox) {
    return [OSM_RESULT_1, OSM_RESULT_2];
  },
};

const overtureProvider: PoiSearchProvider = {
  id: "overture",
  categories: ["cafes", "restaurants", "bars"],
  async search(_cat, _bbox) {
    return [OVERTURE_MATCHED, OVERTURE_EXTRA];
  },
};

describe("(A) Overture absent — optionality guarantee", () => {
  it("returns overpass output deep-equal unchanged when only overpass is registered", async () => {
    const orch = createPoiSearchOrchestrator(makeCtx([overpassProvider]));
    const result = await orch.search("cafes", BBOX);
    expect(result.results).toStrictEqual([OSM_RESULT_1, OSM_RESULT_2]);
    expect(result.partial).toBe(false);
  });
});

describe("(B) Both registered — fusion", () => {
  it("fused result carries gersId from the matched Overture entry", async () => {
    const orch = createPoiSearchOrchestrator(makeCtx([overpassProvider, overtureProvider]));
    const result = await orch.search("cafes", BBOX);
    const fused = result.results.find((r) => r.id === "osm:node/1");
    expect(fused).toBeDefined();
    expect(fused?.gersId).toBe("gers-starbucks-001");
  });

  it("Overture-only result appears as gap-fill", async () => {
    const orch = createPoiSearchOrchestrator(makeCtx([overpassProvider, overtureProvider]));
    const result = await orch.search("cafes", BBOX);
    const gapFill = result.results.find((r) => r.id === "overture:gers-new-venue-999");
    expect(gapFill).toBeDefined();
  });

  it("total result count equals osm count + overture-only count", async () => {
    const orch = createPoiSearchOrchestrator(makeCtx([overpassProvider, overtureProvider]));
    const result = await orch.search("cafes", BBOX);
    expect(result.results).toHaveLength(3);
  });

  it("brand osmTags from Overture are merged onto the fused OSM result", async () => {
    const orch = createPoiSearchOrchestrator(makeCtx([overpassProvider, overtureProvider]));
    const result = await orch.search("cafes", BBOX);
    const fused = result.results.find((r) => r.id === "osm:node/1");
    expect(fused?.osmTags?.brand).toBe("Starbucks");
    expect(fused?.osmTags?.["brand:wikidata"]).toBe("Q37158");
  });
});

describe("(C) Category routing", () => {
  it("a commercial category fans out to 2 providers when both are registered", async () => {
    let overpassCallCount = 0;
    let overtureCallCount = 0;
    const trackingOverpass: PoiSearchProvider = {
      id: "overpass",
      categories: ["cafes"],
      async search() {
        overpassCallCount++;
        return [];
      },
    };
    const trackingOverture: PoiSearchProvider = {
      id: "overture",
      categories: ["cafes"],
      async search() {
        overtureCallCount++;
        return [];
      },
    };
    const orch = createPoiSearchOrchestrator(makeCtx([trackingOverpass, trackingOverture]));
    await orch.search("cafes", BBOX);
    expect(overpassCallCount).toBe(1);
    expect(overtureCallCount).toBe(1);
  });

  it("'viewpoints' stays single-provider (only overpass covers it)", async () => {
    let overpassCallCount = 0;
    let overtureCallCount = 0;
    const trackingOverpass: PoiSearchProvider = {
      id: "overpass",
      categories: ["viewpoints"],
      async search() {
        overpassCallCount++;
        return [];
      },
    };
    const trackingOverture: PoiSearchProvider = {
      id: "overture",
      categories: ["cafes", "restaurants"],
      async search() {
        overtureCallCount++;
        return [];
      },
    };
    const orch = createPoiSearchOrchestrator(makeCtx([trackingOverpass, trackingOverture]));
    await orch.search("viewpoints", BBOX);
    expect(overpassCallCount).toBe(1);
    expect(overtureCallCount).toBe(0);
  });
});

describe("(C2) OverpassTimeoutError propagates from fused search", () => {
  it("search() rejects with OverpassTimeoutError when overpass throws it (not swallowed)", async () => {
    const timeoutOverpass: PoiSearchProvider = {
      id: "overpass",
      categories: ["cafes"],
      async search() {
        throw new OverpassTimeoutError("area_too_large");
      },
    };
    const silentOverture: PoiSearchProvider = {
      id: "overture",
      categories: ["cafes"],
      async search() {
        return [];
      },
    };
    const orch = createPoiSearchOrchestrator(makeCtx([timeoutOverpass, silentOverture]));
    await expect(orch.search("cafes", BBOX)).rejects.toBeInstanceOf(OverpassTimeoutError);
  });
});

describe("(D) Link-table wiring — ctx.db integration", () => {
  // OSM at 52.5100 — Overture at 52.5104 (~45m apart, beyond alwaysMergeM=25m).
  // Names "HARMANS KFC #189" vs "Starbucks Coffee" have Dice << 0.8, so union-find
  // will NOT match. The link table entry forces the fuse.
  const dissimilarOsmProvider: PoiSearchProvider = {
    id: "overpass",
    categories: ["cafes"],
    async search() {
      return [
        {
          id: "osm:node/1",
          name: "HARMANS KFC #189",
          coordinates: [13.4, 52.51],
          category: "cafes",
        } satisfies PoiSearchResult,
        {
          id: "osm:node/2",
          name: "Einstein Kaffee",
          coordinates: [13.42, 52.52],
          category: "cafes",
        } satisfies PoiSearchResult,
      ];
    },
  };

  const overtureWithGers: PoiSearchProvider = {
    id: "overture",
    categories: ["cafes"],
    async search() {
      return [
        {
          id: "overture:gers-starbucks-001",
          gersId: "gers-starbucks-001",
          name: "Starbucks Coffee",
          coordinates: [13.4, 52.5104],
          category: "cafes",
          osmTags: { brand: "Starbucks", "brand:wikidata": "Q37158" },
        } satisfies PoiSearchResult,
      ];
    },
  };

  it("without ctx.db, dissimilar-name nearby pair is NOT fused (proves link is needed)", async () => {
    const orchNoDb = createPoiSearchOrchestrator(
      makeCtx([dissimilarOsmProvider, overtureWithGers]),
    );
    const result = await orchNoDb.search("cafes", BBOX);
    const entry = result.results.find((r) => r.id === "osm:node/1");
    expect(entry?.gersId).toBeUndefined();
  });

  it("fuses via link when ctx.db returns a link row, even with dissimilar names", async () => {
    const db = {
      execute: async () =>
        [{ osm_type: "node", osm_id: 1, gers_id: "gers-starbucks-001" }] as unknown[],
    };
    const orch = createPoiSearchOrchestrator(
      makeCtx([dissimilarOsmProvider, overtureWithGers], db),
    );
    const result = await orch.search("cafes", BBOX);
    const fused = result.results.find((r) => r.id === "osm:node/1");
    expect(fused).toBeDefined();
    expect(fused?.gersId).toBe("gers-starbucks-001");
    expect(fused?.osmTags?.brand).toBe("Starbucks");
  });

  it("without ctx.db falls back to union-find only — output deep-equal to no-db baseline", async () => {
    const orchWithoutDb = createPoiSearchOrchestrator(
      makeCtx([overpassProvider, overtureProvider]),
    );
    const orchWithUndefinedDb = createPoiSearchOrchestrator(
      makeCtx([overpassProvider, overtureProvider], undefined),
    );
    const [resultA, resultB] = await Promise.all([
      orchWithoutDb.search("cafes", BBOX),
      orchWithUndefinedDb.search("cafes", BBOX),
    ]);
    expect(resultB.results).toStrictEqual(resultA.results);
    expect(resultB.partial).toStrictEqual(resultA.partial);
  });

  it("issues exactly one batched db query per search call (no N+1)", async () => {
    let queryCount = 0;
    const db = {
      execute: async () => {
        queryCount++;
        return [] as unknown[];
      },
    };
    const orch = createPoiSearchOrchestrator(makeCtx([overpassProvider, overtureProvider], db));
    await orch.search("cafes", BBOX);
    expect(queryCount).toBe(1);
  });
});
