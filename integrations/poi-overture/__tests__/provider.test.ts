import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { PoiSearchProvider } from "@openmapx/integration-poi-search/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BBOX = { south: 52.49, west: 13.38, north: 52.53, east: 13.43 };

const FIXTURE_ROWS = [
  {
    gers_id: "gers-abc-001",
    name: "Starbucks Mitte",
    longitude: 13.4,
    latitude: 52.51,
    openmapx_category: "cafes",
    basic_category: "coffee_shop",
    brand_name: "Starbucks",
    brand_wikidata: "Q37158",
    phone: null,
  },
  {
    gers_id: "gers-abc-002",
    name: "McDonald's Alexanderplatz",
    longitude: 13.41,
    latitude: 52.52,
    openmapx_category: "restaurants",
    basic_category: "burger_restaurant",
    brand_name: "McDonald's",
    brand_wikidata: "Q38076",
    phone: "+49 30 12345678",
  },
];

function makeFakeDb(rows: unknown[] = FIXTURE_ROWS) {
  return {
    execute: vi.fn().mockResolvedValue(rows),
  };
}

describe("poi-overture setup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers a health check and a POI search provider when db is available", async () => {
    const db = makeFakeDb([]);
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    expect(ctx.registered.poiSearch).toHaveLength(1);
    expect(ctx.registered.healthChecks).toHaveLength(1);
  });

  it("no-ops (logs warn) when ctx.db is undefined", async () => {
    const warnSpy = vi.fn();
    const ctx = createMockIntegrationContext({
      log: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
    });
    const { setup } = await import("../index.js");
    setup(ctx);
    expect(ctx.registered.poiSearch).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[poi-overture]"));
  });
});

describe("poi-overture provider.search", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns mapped rows with correct id, gersId, and osmTags", async () => {
    const db = makeFakeDb(FIXTURE_ROWS);
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    const provider = ctx.registered.poiSearch[0] as PoiSearchProvider;
    const results = await provider.search("cafes", BBOX);
    expect(results.length).toBe(2);
    const first = results[0];
    expect(first.id).toBe("overture:gers-abc-001");
    expect(first.gersId).toBe("gers-abc-001");
    expect(first.osmTags?.brand).toBe("Starbucks");
    expect(first.osmTags?.["brand:wikidata"]).toBe("Q37158");
    expect(first.coordinates).toEqual([13.4, 52.51]);
  });

  it("returns [] for non-commercial category that has no Overture leaves", async () => {
    const db = makeFakeDb(FIXTURE_ROWS);
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    const provider = ctx.registered.poiSearch[0] as PoiSearchProvider;
    const results = await provider.search("drinking_water", BBOX);
    expect(results).toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("includes phone when present", async () => {
    const db = makeFakeDb([FIXTURE_ROWS[1]]);
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    const provider = ctx.registered.poiSearch[0] as PoiSearchProvider;
    const results = await provider.search("restaurants", BBOX);
    expect(results[0].phone).toBe("+49 30 12345678");
  });
});

describe("poi-overture health check", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns up when overture_places.places is queryable", async () => {
    const db = makeFakeDb([{ "?column?": 1 }]);
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    const healthCheck = ctx.registered.healthChecks[0];
    const status = await healthCheck();
    expect(status.status).toBe("up");
  });

  it("returns down when overture_places.places query throws", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("relation does not exist")),
    };
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    const healthCheck = ctx.registered.healthChecks[0];
    const status = await healthCheck();
    expect(status.status).toBe("down");
  });
});
