import { describe, expect, it } from "vitest";
import { type CategoryPlace, categoryPlaceToPlace } from "../category";

function makePlace(overrides: Partial<CategoryPlace> = {}): CategoryPlace {
  return {
    id: "osm:node/123",
    name: "Test place",
    coordinates: [6.08, 50.77],
    ...overrides,
  };
}

describe("categoryPlaceToPlace", () => {
  it("preserves an OSM primary id and carries a conflated GERS reference", () => {
    const place = categoryPlaceToPlace(makePlace({ gersId: "gers-123" }), "cafes");

    expect(place.id).toBe("osm:node/123");
    expect(place.primaryScheme).toBe("osm");
    expect(place.ids).toEqual({
      osm: "node/123",
      overture: "gers-123",
      gers: "gers-123",
    });
  });

  it("keeps an Overture-only result resolvable as overture:<gers>", () => {
    const place = categoryPlaceToPlace(
      makePlace({ id: "overture:gers-456", gersId: "gers-456" }),
      "cafes",
    );

    expect(place.id).toBe("overture:gers-456");
    expect(place.primaryScheme).toBe("overture");
    expect(place.ids).toEqual({ overture: "gers-456", gers: "gers-456" });
  });

  it("falls back to a coordinate identity for a malformed provider id", () => {
    const place = categoryPlaceToPlace(makePlace({ id: "opaque-id" }));

    expect(place.id).toBe("coordinate:50.770000-6.080000");
    expect(place.primaryScheme).toBe("coordinate");
  });

  it("preserves normalized Overture attributes without using the name as an address", () => {
    const place = categoryPlaceToPlace(
      makePlace({
        address: undefined,
        email: "hello@example.test",
        website: "https://example.test",
        socials: ["https://instagram.com/example"],
        brand: { name: "Example", wikidata: "Q1" },
        names: { de: "Beispiel" },
        provenance: [{ sourceId: "overture", dataset: "Overture Maps" }],
      }),
    );

    expect(place.address).toBe("");
    expect(place.email).toBe("hello@example.test");
    expect(place.website).toBe("https://example.test");
    expect(place.socials).toEqual(["https://instagram.com/example"]);
    expect(place.brand).toEqual({ name: "Example", wikidata: "Q1" });
    expect(place.names).toEqual({ de: "Beispiel" });
    expect(place.provenance).toEqual([{ sourceId: "overture", dataset: "Overture Maps" }]);
  });
});
