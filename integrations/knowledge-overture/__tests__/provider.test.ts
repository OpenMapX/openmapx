import type { IntegrationContext } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The knowledge-overture provider performs a two-phase GERS lookup:
// 1. Link-first: osm_type + osm_id → poi_conflation_link (empty until plan 03, always null)
// 2. Spatial+name: ST_DWithin(geom::geography, …, 150) filtered by category, then
//    diceSimilarity(candidate.name, context.name) >= 0.8
// These tests drive the provider in isolation with a mock DatabaseClient.

type MockDb = {
  execute: ReturnType<typeof vi.fn>;
};

function makeDb(overrideExecute?: MockDb["execute"]): MockDb {
  return {
    execute: overrideExecute ?? vi.fn().mockResolvedValue([]),
  };
}

function makeCtx(db?: MockDb): IntegrationContext {
  return {
    id: "knowledge-overture",
    manifest: {} as never,
    config: {},
    http: {} as never,
    cache: {} as never,
    liveStore: {} as never,
    db: db as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    secrets: {} as never,
    registerKnowledgeProvider: vi.fn(),
    registerHealthCheck: vi.fn(),
    registerTransitProvider: vi.fn(),
    registerRealtimeProvider: vi.fn(),
    registerMobilityDataSource: vi.fn(),
    registerWeatherProvider: vi.fn(),
    registerGeocodingProvider: vi.fn(),
    registerRoutingProvider: vi.fn(),
    registerPhotoProvider: vi.fn(),
    registerReviewProvider: vi.fn(),
    registerPoiSearchProvider: vi.fn(),
    registerGtfsCatalogProvider: vi.fn(),
    registerPoiSources: vi.fn(),
    registerRoute: vi.fn(),
    registerDisclosure: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    onShutdown: vi.fn(),
    getIntegrationsByDomain: vi.fn().mockReturnValue([]),
  } as unknown as IntegrationContext;
}

function makeOvertureSpatialRow(overrides?: Partial<{ gers_id: string; name: string }>) {
  return {
    gers_id: overrides?.gers_id ?? "overture-abc-123",
    name: overrides?.name ?? "Starbucks",
  };
}

function makeOvertureDetailRow() {
  return {
    gers_id: "overture-abc-123",
    name: "Starbucks",
    names: { de: "Starbucks", fr: "Starbucks" },
    // Overture nests the brand name under brand.names.primary (NOT brand.name).
    brand: { names: { primary: "Starbucks" }, wikidata: "Q37158" },
    opening_hours: "Mo-Fr 07:00-21:00; Sa-Su 08:00-20:00",
    phones: ["+49 30 1234567"],
    websites: ["https://starbucks.de"],
  };
}

// Reset module registry between tests so bindDb state is fresh.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("knowledge-overture setup", () => {
  it("no-ops when ctx.db is undefined and does not register a knowledge provider", async () => {
    const ctx = makeCtx(undefined);
    const { setup } = await import("../index.js");
    setup(ctx);
    expect(ctx.registerKnowledgeProvider).not.toHaveBeenCalled();
    expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining("[knowledge-overture]"));
  });

  it("registers a knowledge provider when ctx.db is present", async () => {
    const db = makeDb();
    const ctx = makeCtx(db);
    const { setup } = await import("../index.js");
    setup(ctx);
    expect(ctx.registerKnowledgeProvider).toHaveBeenCalledTimes(1);
  });

  it("registers a health check when ctx.db is present", async () => {
    const db = makeDb();
    const ctx = makeCtx(db);
    const { setup } = await import("../index.js");
    setup(ctx);
    expect(ctx.registerHealthCheck).toHaveBeenCalledTimes(1);
  });
});

describe("knowledge-overture provider lookup", () => {
  it("returns null when db is not bound (ctx.db was undefined at setup)", async () => {
    const ctx = makeCtx(undefined);
    const { setup, overtureKnowledgeSource } = await import("../index.js");
    setup(ctx);
    const result = await overtureKnowledgeSource.lookup({ amenity: "cafe" }, "en", {
      coordinates: [13.4, 52.5],
      name: "Starbucks",
    });
    expect(result).toBeNull();
  });

  const detailRowDb = (detailRow: ReturnType<typeof makeOvertureDetailRow>) =>
    makeDb(
      vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("poi_conflation_link")) return Promise.resolve([]);
        if (sql.includes("places") && sql.includes("ST_DWithin")) {
          return Promise.resolve([makeOvertureSpatialRow()]);
        }
        if (sql.includes("gers_id")) return Promise.resolve([detailRow]);
        return Promise.resolve([]);
      }),
    );

  it("returns brand, names, hours, wikidata, phone and website from the Overture row", async () => {
    const ctx = makeCtx(detailRowDb(makeOvertureDetailRow()));
    const { setup, overtureKnowledgeSource } = await import("../index.js");
    setup(ctx);

    const result = await overtureKnowledgeSource.lookup(
      { amenity: "cafe", category: "coffee" },
      "en",
      { coordinates: [13.4, 52.5], name: "Starbucks", ids: { osm: "node/123456789" } },
    );

    expect(result).not.toBeNull();
    // Brand name comes from the NESTED brand.names.primary, not brand.name.
    expect(result?.brand).toEqual({ name: "Starbucks", wikidata: "Q37158" });
    expect(result?.names).toEqual({ de: "Starbucks", fr: "Starbucks" });
    expect(result?.structuredOpeningHours).toBe("Mo-Fr 07:00-21:00; Sa-Su 08:00-20:00");
    expect(result?.externalIds?.wikidata).toBe("Q37158");
    expect(result?.phone).toBe("+49 30 1234567");
    expect(result?.website).toBe("https://starbucks.de");
  });

  it("exposes wikidata via externalIds even when the brand has no resolvable name", async () => {
    const row = makeOvertureDetailRow();
    row.brand = { names: null, wikidata: "Q37158" } as never;
    const ctx = makeCtx(detailRowDb(row));
    const { setup, overtureKnowledgeSource } = await import("../index.js");
    setup(ctx);

    const result = await overtureKnowledgeSource.lookup({ amenity: "cafe" }, "en", {
      coordinates: [13.4, 52.5],
      name: "Starbucks",
      ids: { osm: "node/123456789" },
    });

    expect(result?.brand).toBeUndefined();
    expect(result?.externalIds?.wikidata).toBe("Q37158");
  });

  it("surfaces phone/website even for an unbranded place with no hours", async () => {
    const row = makeOvertureDetailRow();
    row.brand = null as never;
    row.opening_hours = null as never;
    row.names = null as never;
    const ctx = makeCtx(detailRowDb(row));
    const { setup, overtureKnowledgeSource } = await import("../index.js");
    setup(ctx);

    const result = await overtureKnowledgeSource.lookup({ amenity: "restaurant" }, "en", {
      coordinates: [11.576, 48.137],
      name: "Starbucks",
      ids: { osm: "node/60013073" },
    });

    expect(result).not.toBeNull();
    expect(result?.phone).toBe("+49 30 1234567");
    expect(result?.website).toBe("https://starbucks.de");
    expect(result?.brand).toBeUndefined();
  });

  it("returns null when no candidate is within 150 m", async () => {
    const db = makeDb(
      vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("poi_conflation_link")) return Promise.resolve([]);
        if (sql.includes("ST_DWithin")) return Promise.resolve([]);
        return Promise.resolve([]);
      }),
    );
    const ctx = makeCtx(db);
    const { setup, overtureKnowledgeSource } = await import("../index.js");
    setup(ctx);

    const result = await overtureKnowledgeSource.lookup({ amenity: "cafe" }, "en", {
      coordinates: [13.4, 52.5],
      name: "Starbucks",
    });
    expect(result).toBeNull();
  });

  it("returns null when candidates exist but name similarity is below 0.8", async () => {
    const db = makeDb(
      vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("poi_conflation_link")) return Promise.resolve([]);
        if (sql.includes("ST_DWithin")) {
          return Promise.resolve([makeOvertureSpatialRow({ name: "Completely Different Name" })]);
        }
        return Promise.resolve([]);
      }),
    );
    const ctx = makeCtx(db);
    const { setup, overtureKnowledgeSource } = await import("../index.js");
    setup(ctx);

    const result = await overtureKnowledgeSource.lookup({ amenity: "cafe" }, "en", {
      coordinates: [13.4, 52.5],
      name: "Starbucks",
    });
    expect(result).toBeNull();
  });

  it("tolerates context.ids being undefined (neighborhoods call site)", async () => {
    const detailRow = makeOvertureDetailRow();
    const db = makeDb(
      vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("poi_conflation_link")) return Promise.resolve([]);
        if (sql.includes("ST_DWithin")) {
          return Promise.resolve([makeOvertureSpatialRow()]);
        }
        if (sql.includes("gers_id")) return Promise.resolve([detailRow]);
        return Promise.resolve([]);
      }),
    );
    const ctx = makeCtx(db);
    const { setup, overtureKnowledgeSource } = await import("../index.js");
    setup(ctx);

    await expect(
      overtureKnowledgeSource.lookup({ amenity: "cafe" }, "en", {
        coordinates: [13.4, 52.5],
        name: "Starbucks",
      }),
    ).resolves.not.toThrow();
  });

  it("returns null when entire resolveGers exceeds 1500 ms deadline", async () => {
    const db = makeDb(
      vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("poi_conflation_link")) return Promise.resolve([]);
        if (sql.includes("ST_DWithin")) {
          return new Promise((resolve) => setTimeout(() => resolve([]), 2000));
        }
        return Promise.resolve([]);
      }),
    );
    const ctx = makeCtx(db);
    const { setup, overtureKnowledgeSource } = await import("../index.js");
    setup(ctx);

    const start = Date.now();
    const result = await overtureKnowledgeSource.lookup({ amenity: "cafe" }, "en", {
      coordinates: [13.4, 52.5],
      name: "Starbucks",
    });
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(2000);
  }, 3000);
});
