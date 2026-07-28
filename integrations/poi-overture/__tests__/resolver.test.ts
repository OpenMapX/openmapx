import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GERS_ID = "overture-0f3a2b1c-dead-beef-cafe-123456789abc";

const FIXTURE_ROW = {
  gers_id: GERS_ID,
  name: "Test Cafe Berlin",
  longitude: 13.405,
  latitude: 52.52,
  basic_category: "coffee_shop",
  taxonomy_primary: "coffee_shop",
  taxonomy_hierarchy: ["food_and_drink", "cafe", "coffee_shop"],
  taxonomy_alternates: [],
  brand_name: "Starbucks",
  brand_wikidata: "Q37158",
  phone: "+49 30 12345",
};

function makeFakeDb(row: unknown | null) {
  return {
    execute: vi.fn().mockResolvedValue(row ? [row] : []),
  };
}

describe("overture place resolver", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves a known GERS to a Place with primaryScheme:overture", async () => {
    const db = makeFakeDb(FIXTURE_ROW);
    const ctx = createMockIntegrationContext({ db });

    // Import after resetModules so the registry and integration share the same module instance.
    const { setup } = await import("../index.js");
    const { getPlaceResolver } = await import("@openmapx/place-ids");

    setup(ctx);

    const resolver = getPlaceResolver("overture");
    expect(resolver).toBeDefined();

    const place = await resolver?.(GERS_ID, {});
    expect(place).not.toBeNull();
    expect(place?.primaryScheme).toBe("overture");
    expect(place?.id).toBe(`overture:${GERS_ID}`);
    expect(place?.ids.overture).toBe(GERS_ID);
    expect(place?.name).toBe("Test Cafe Berlin");
    expect(place?.coordinates).toEqual([13.405, 52.52]);
    expect(place?.osmTags?.brand).toBe("Starbucks");
    expect(place?.osmTags?.["brand:wikidata"]).toBe("Q37158");
  });

  it("returns null for an unknown GERS (no db row)", async () => {
    const db = makeFakeDb(null);
    const ctx = createMockIntegrationContext({ db });

    const { setup } = await import("../index.js");
    const { getPlaceResolver } = await import("@openmapx/place-ids");

    setup(ctx);

    const resolver = getPlaceResolver("overture");
    expect(resolver).toBeDefined();

    const place = await resolver?.(GERS_ID, {});
    expect(place).toBeNull();
  });

  it("does not register the resolver when ctx.db is undefined", async () => {
    const ctx = createMockIntegrationContext();

    const { setup } = await import("../index.js");
    const { getPlaceResolver } = await import("@openmapx/place-ids");

    setup(ctx);

    // No db → resolver should not have been registered (fresh registry after resetModules).
    const resolver = getPlaceResolver("overture");
    expect(resolver).toBeUndefined();
  });
});
