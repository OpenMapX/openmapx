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
    basic_category: "coffee_shop",
    taxonomy_primary: "coffee_shop",
    taxonomy_hierarchy: ["food_and_drink", "cafe", "coffee_shop"],
    taxonomy_alternates: [],
    names: { primary: "Starbucks Mitte", common: { de: "Starbucks Mitte DE" } },
    addresses: [
      { freeform: "Friedrichstraße 1", locality: "Berlin", postcode: "10117", country: "DE" },
    ],
    brand: { names: { primary: "Starbucks" }, wikidata: "Q37158" },
    phones: null,
    websites: ["https://starbucks.example/mitte"],
    socials: ["https://instagram.com/starbucks"],
    emails: ["mitte@starbucks.example"],
    sources: [
      {
        property: "",
        dataset: "Foursquare",
        record_id: "fsq-1",
        update_time: "2026-03-18T00:00:00Z",
        license: "Apache-2.0",
      },
    ],
    release: "2026-07-22.0",
  },
  {
    gers_id: "gers-abc-002",
    name: "McDonald's Alexanderplatz",
    longitude: 13.41,
    latitude: 52.52,
    basic_category: "burger_restaurant",
    taxonomy_primary: "burger_restaurant",
    taxonomy_hierarchy: ["food_and_drink", "restaurant", "burger_restaurant"],
    taxonomy_alternates: [],
    names: { primary: "McDonald's Alexanderplatz", common: null },
    addresses: null,
    brand: { names: { primary: "McDonald's" }, wikidata: "Q38076" },
    phones: ["+49 30 12345678"],
    websites: null,
    socials: null,
    emails: null,
    sources: [{ property: "", dataset: "meta", record_id: "meta-2" }],
    release: "2026-07-22.0",
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
    const results = await provider.search("cafes", BBOX, { lang: "de-DE" });
    expect(results.length).toBe(2);
    const first = results[0];
    expect(first.id).toBe("overture:gers-abc-001");
    expect(first.gersId).toBe("gers-abc-001");
    expect(first.osmTags?.brand).toBe("Starbucks");
    expect(first.osmTags?.["brand:wikidata"]).toBe("Q37158");
    expect(first.coordinates).toEqual([13.4, 52.51]);
    expect(first.name).toBe("Starbucks Mitte DE");
    expect(first.address).toBe("Friedrichstraße 1, 10117 Berlin");
    expect(first.website).toBe("https://starbucks.example/mitte");
    expect(first.email).toBe("mitte@starbucks.example");
    expect(first.category).toBe("cafes");
    expect(first.provenance?.map((source) => source.sourceId)).toEqual(["overture", "foursquare"]);
    expect(db.execute.mock.calls[0][0]).toContain("taxonomy_hierarchy && $5::TEXT[]");
    expect(db.execute.mock.calls[0][0]).toContain("ORDER BY");
    expect(db.execute.mock.calls[0][0]).toContain("confidence DESC NULLS LAST");
    expect(db.execute.mock.calls[0][1][4]).toEqual(["cafe", "coffee_shop", "tea_house"]);
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
    const db = makeFakeDb([
      {
        place_count: "3913971",
        place_release: "2026-07-22.0",
        state_release: "2026-07-22.0",
        status: "completed",
        phase: "complete",
        updated_at: new Date(),
        last_error: null,
      },
    ]);
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    const healthCheck = ctx.registered.healthChecks[0];
    const status = await healthCheck();
    expect(status.status).toBe("up");
  });

  it("keeps searchable places up while reporting a failed optional conflation phase", async () => {
    const db = makeFakeDb([
      {
        place_count: 100,
        place_release: "2026-07-22.0",
        state_release: "2026-07-22.0",
        status: "failed",
        phase: "assign",
        updated_at: new Date(),
        last_error: "worker restarted",
      },
    ]);
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    const status = await ctx.registered.healthChecks[0]();
    expect(status).toEqual({
      status: "up",
      error: "Places available; conflation is failed in assign: worker restarted",
    });
  });

  it("returns down when the place snapshot and conflation state releases disagree", async () => {
    const db = makeFakeDb([
      {
        place_count: 100,
        place_release: "2026-07-22.0",
        state_release: "2026-06-18.0",
        status: "completed",
        phase: "complete",
        updated_at: new Date(),
        last_error: null,
      },
    ]);
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    const status = await ctx.registered.healthChecks[0]();
    expect(status.status).toBe("down");
    expect(status.error).toContain("release mismatch");
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
