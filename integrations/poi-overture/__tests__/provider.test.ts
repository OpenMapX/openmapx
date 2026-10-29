import { toPoiSearchOutcome } from "@openmapx/core";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { PoiSearchProvider, PoiSearchReturn } from "@openmapx/integration-poi-search/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Providers may answer with a bare array or an outcome; normalize either. */
async function toOutcome(pending: Promise<PoiSearchReturn>) {
  return toPoiSearchOutcome(await pending);
}

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
    const { results, truncated } = await toOutcome(
      provider.search("cafes", BBOX, { lang: "de-DE" }),
    );
    expect(results.length).toBe(2);
    expect(truncated).toBe(false);
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
    const { results } = await toOutcome(provider.search("drinking_water", BBOX));
    expect(results).toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("includes phone when present", async () => {
    const db = makeFakeDb([FIXTURE_ROWS[1]]);
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    const provider = ctx.registered.poiSearch[0] as PoiSearchProvider;
    const { results } = await toOutcome(provider.search("restaurants", BBOX));
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

describe("canonical accepted-link identity", () => {
  it("uses the accepted OSM id even when only the Overture search row is returned", async () => {
    const db = makeFakeDb([{ ...FIXTURE_ROWS[0], canonical_id: "osm:node/9007199254740993" }]);
    const ctx = createMockIntegrationContext({ db });
    const { setup } = await import("../index.js");
    setup(ctx);
    const provider = ctx.registered.poiSearch[0];
    const result = await toOutcome(provider.search("cafes", BBOX));
    expect(result.results[0]).toMatchObject({
      id: "osm:node/9007199254740993",
      gersId: "gers-abc-001",
    });
  });
});

it("captures exact localized-name and contact suppliers before the database read settles", async () => {
  const manifest = structuredClone((await import("../manifest.json")).default);
  const nameSource = manifest.dataSources.find((source) => source.sourceId === "microsoft-places")!;
  const originalName = nameSource.name;
  const sources_catalogue = manifest.dataSources.map((source) => ({
    sourceId: source.sourceId,
    name: source.name,
  }));
  let finish!: (rows: unknown[]) => void;
  const db = makeFakeDb();
  db.execute.mockReturnValue(
    new Promise<unknown[]>((resolve) => {
      finish = resolve;
    }),
  );
  const ctx = createMockIntegrationContext({ db, manifest: manifest as never });
  const { setup } = await import("../index.js");
  setup(ctx);
  const provider = ctx.registered.poiSearch[0] as PoiSearchProvider;
  const pending = toOutcome(provider.search("cafes", BBOX, { lang: "de" }));
  nameSource.name = "Changed catalogue";
  finish([
    {
      ...FIXTURE_ROWS[0],
      sources_catalogue,
      names: { primary: "Base", common: { de: "Cafe" } },
      phones: ["123"],
      sources: [
        { property: "", dataset: "Meta" },
        { property: "/names/common/de", dataset: "Microsoft" },
        { property: "/phones/0", dataset: "Foursquare" },
      ],
    },
  ]);
  const result = (await pending).results[0];
  expect(result.fieldContributors?.name?.map((receipt) => receipt.sourceId).sort()).toEqual([
    "microsoft-places",
    "overture",
  ]);
  expect(
    result.fieldContributors?.name?.find((receipt) => receipt.sourceId === "microsoft-places")
      ?.name,
  ).toBe(originalName);
  expect(result.fieldContributors?.coordinates?.map((receipt) => receipt.sourceId).sort()).toEqual([
    "meta-places",
    "overture",
  ]);
  expect(result.fieldContributors?.phone?.map((receipt) => receipt.sourceId).sort()).toEqual([
    "foursquare",
    "overture",
  ]);
});
it("does not invent historical publishers for legacy rows or replace explicit empty catalogues", async () => {
  const manifest = (await import("../manifest.json")).default;
  const db = makeFakeDb();
  db.execute.mockResolvedValue([
    { ...FIXTURE_ROWS[0], sources: [{ property: "", dataset: "Meta" }] },
  ]);
  const ctx = createMockIntegrationContext({ db, manifest: manifest as never });
  const { setup } = await import("../index.js");
  setup(ctx);
  const provider = ctx.registered.poiSearch[0] as PoiSearchProvider;
  expect(
    (await toOutcome(provider.search("cafes", BBOX))).results[0].contributors?.map(
      (r) => r.sourceId,
    ),
  ).toEqual(["overture"]);
  db.execute.mockResolvedValue([
    { ...FIXTURE_ROWS[0], sources_catalogue: [], sources: [{ property: "", dataset: "Meta" }] },
  ]);
  expect((await toOutcome(provider.search("cafes", BBOX))).results[0].contributors).toEqual([]);
});

const reviewedRow = {
  ...FIXTURE_ROWS[0],
  basic_category: "cafe",
  taxonomy_primary: "cafe",
  taxonomy_hierarchy: [],
  taxonomy_alternates: ["restaurant"],
  brand: { names: { primary: "English Brand", common: { de: "Deutsche Marke" } } },
  sources: [
    { property: "/brand/names/primary", dataset: "meta" },
    { property: "/brand/names/common/de", dataset: "Microsoft" },
    { property: "/basic_category", dataset: "meta" },
    { property: "/taxonomy/primary", dataset: "meta" },
    { property: "/taxonomy/alternates/0", dataset: "Microsoft" },
  ],
  sources_catalogue: [
    { sourceId: "overture", name: "Captured Overture" },
    { sourceId: "meta-places", name: "English and cafe" },
    { sourceId: "microsoft-places", name: "German and restaurant" },
  ],
};
it("captures the actual localized brand name pointer on the normalized brand and OSM tag", async () => {
  const { setup } = await import("../index.js");
  const ctx = createMockIntegrationContext({ db: makeFakeDb([reviewedRow]) });
  setup(ctx);
  const result = (
    await toOutcome(ctx.registered.poiSearch[0].search("cafes", BBOX, { lang: "de" }))
  ).results[0];
  expect(result.brand?.name).toBe("Deutsche Marke");
  expect(result.fieldContributors?.brand.map((r) => r.sourceId)).toEqual([
    "overture",
    "microsoft-places",
  ]);
  expect(result.fieldContributors?.["brand.name"].map((r) => r.sourceId)).toEqual([
    "overture",
    "microsoft-places",
  ]);
  expect(result.fieldContributors?.["osmTags.brand"].map((r) => r.sourceId)).toEqual([
    "overture",
    "microsoft-places",
  ]);
});
it("credits the retained requested category rather than a competing global taxonomy winner", async () => {
  const { setup } = await import("../index.js");
  const db = makeFakeDb([reviewedRow]);
  const ctx = createMockIntegrationContext({ db });
  setup(ctx);
  const provider = ctx.registered.poiSearch[0];
  const result = (await toOutcome(provider.search("cafes", BBOX))).results[0];
  expect(result.category).toBe("cafes");
  expect(result.fieldContributors?.category.map((r) => r.sourceId)).toEqual([
    "overture",
    "meta-places",
  ]);
  db.execute.mockResolvedValue([
    {
      ...reviewedRow,
      basic_category: null,
      taxonomy_primary: null,
      taxonomy_alternates: ["restaurant"],
    },
  ]);
  const criterion = (await toOutcome(provider.search("cafes", BBOX))).results[0];
  expect(criterion.category).toBe("cafes");
  expect(criterion.fieldContributors?.category).toEqual([]);
});
