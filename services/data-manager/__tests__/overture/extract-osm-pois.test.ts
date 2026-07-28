import { describe, expect, it } from "vitest";
import {
  featureToOsmPoiRecord,
  representativePoint,
} from "../../src/jobs/overture/extract-osm-pois.js";

describe("featureToOsmPoiRecord", () => {
  it("maps a named Point feature with a type_id to an OsmPoiRecord", () => {
    const rec = featureToOsmPoiRecord({
      id: "n123",
      geometry: { type: "Point", coordinates: [13.4, 52.5] },
      properties: { name: "Späti", shop: "convenience" },
    });
    expect(rec).toEqual({
      osmType: "node",
      osmId: "123",
      name: "Späti",
      lat: 52.5,
      lng: 13.4,
      h3R8: expect.any(String),
      category: expect.anything(),
      tags: { name: "Späti", shop: "convenience" },
    });
  });

  it("derives osmType from the way/relation id prefix and uses a representative point", () => {
    const way = featureToOsmPoiRecord({
      id: "w999",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [10, 50],
            [12, 50],
            [12, 52],
            [10, 52],
            [10, 50],
          ],
        ],
      },
      properties: { name: "Park" },
    });
    expect(way?.osmType).toBe("way");
    expect(way?.osmId).toBe("999");
    expect(way?.lat).toBeCloseTo(51, 0);
  });

  it("returns null for unnamed features, missing geometry, or unparseable ids", () => {
    expect(
      featureToOsmPoiRecord({ id: "n1", geometry: { type: "Point", coordinates: [1, 2] } }),
    ).toBeNull();
    expect(featureToOsmPoiRecord({ id: "n1", properties: { name: "x" } })).toBeNull();
    expect(
      featureToOsmPoiRecord({
        id: "",
        geometry: { type: "Point", coordinates: [1, 2] },
        properties: { name: "x" },
      }),
    ).toBeNull();
  });

  it("rejects coordinates that cannot be indexed by H3", () => {
    expect(
      featureToOsmPoiRecord({
        id: "n1",
        geometry: { type: "Point", coordinates: [13.4, 95] },
        properties: { name: "Invalid" },
      }),
    ).toBeNull();
  });
});

describe("representativePoint", () => {
  it("returns the mean lat/lng for a simple Polygon ring", () => {
    const geom = {
      type: "Polygon",
      coordinates: [
        [
          [10, 50],
          [12, 50],
          [12, 52],
          [10, 52],
          [10, 50],
        ],
      ],
    };
    const result = representativePoint(geom);
    if (result === null) throw new Error("expected a representative point");
    const [lng, lat] = result;
    expect(lat).toBeCloseTo(50.8, 1);
    // Circular mean of [10, 12, 12, 10, 10] ≈ 10.8 (slightly below arithmetic 10.8
    // due to circular path vs straight line at these small angles)
    expect(lng).toBeCloseTo(10.8, 0);
  });

  it("returns null for an empty ring", () => {
    expect(representativePoint({ type: "Polygon", coordinates: [[]] })).toBeNull();
  });

  it("antimeridian ring: lngs straddling ±180 yield a representative lng near ±180, not ~0", () => {
    // A ring with vertices at lng -179 and lng 179 should resolve near ±180
    // via circular mean, not to ~0 which arithmetic mean would give.
    const geom = {
      type: "Polygon",
      coordinates: [
        [
          [-179, 60],
          [179, 60],
          [179, 61],
          [-179, 61],
          [-179, 60],
        ],
      ],
    };
    const result = representativePoint(geom);
    if (result === null) throw new Error("expected a representative point");
    const [lng, lat] = result;
    // Circular mean of -179 and 179 (via sin/cos) should yield ±180 (wraps to 180 or -180).
    // The absolute value of the result should be close to 180, not 0.
    expect(Math.abs(lng)).toBeGreaterThan(170);
    expect(lat).toBeCloseTo(60.4, 1);
  });
});
