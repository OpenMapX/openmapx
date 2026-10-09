import { describe, expect, it } from "vitest";
import { featureToSearchPlace } from "../../src/jobs/search-index/extract.js";

describe("featureToSearchPlace", () => {
  it("maps an eligible point and its terms", () => {
    const place = featureToSearchPlace({
      type: "Feature",
      id: "n42",
      geometry: { type: "Point", coordinates: [13.4, 52.5] },
      properties: { name: "Berlin Brandenburg Airport", aeroway: "aerodrome", iata: "BER" },
    });
    expect(place).toEqual(
      expect.objectContaining({ osmType: "node", osmId: "42", lat: 52.5, lng: 13.4 }),
    );
    expect(place?.terms).toContainEqual(
      expect.objectContaining({ displayValue: "BER", kind: "authoritative_code" }),
    );
  });

  it("rejects invalid coordinates and ineligible features", () => {
    expect(
      featureToSearchPlace({
        type: "Feature",
        id: "n1",
        geometry: { type: "Point", coordinates: [181, 52] },
        properties: { name: "Invalid", place: "city" },
      }),
    ).toBeNull();
    expect(
      featureToSearchPlace({
        type: "Feature",
        id: "w2",
        geometry: { type: "Point", coordinates: [13, 52] },
        properties: { name: "House", building: "yes" },
      }),
    ).toBeNull();
  });
});

it("retains named cafes without inventing alias terms", () => {
  expect(
    featureToSearchPlace({
      type: "Feature",
      id: "n999",
      geometry: { type: "Point", coordinates: [139.7, 35.7] },
      properties: { name: "喫茶店", amenity: "cafe" },
    }),
  ).toMatchObject({ osmId: "999", name: "喫茶店", terms: [] });
});
