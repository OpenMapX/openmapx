import { describe, expect, it } from "vitest";
import {
  deduplicateOsmPoiRecords,
  featureToOsmPoiRecord,
  OSMIUM_EXPORT_STREAM_OPTIONS,
  representativePoint,
} from "../../src/jobs/overture/extract-osm-pois.js";

describe("OSM POI batch deduplication", () => {
  it("keeps the later geometry for duplicate source identities", () => {
    const first = featureToOsmPoiRecord({
      id: "w42",
      geometry: {
        type: "LineString",
        coordinates: [
          [1, 1],
          [2, 2],
        ],
      },
      properties: { name: "First" },
    });
    const later = featureToOsmPoiRecord({
      id: "a84",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [1, 1],
            [2, 1],
            [1, 1],
          ],
        ],
      },
      properties: { name: "Later" },
    });
    if (!first || !later) throw new Error("expected records");

    expect(deduplicateOsmPoiRecords([first, later])).toEqual([later]);
  });
});

describe("OSM POI export streaming", () => {
  it("disables Execa buffering for country-scale GeoJSON output", () => {
    expect(OSMIUM_EXPORT_STREAM_OPTIONS).toMatchObject({ stdout: "pipe", buffer: false });
  });
});

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

  it("uses Osmium source attributes for areas and excludes them from OSM tags", () => {
    const area = featureToOsmPoiRecord({
      id: "a50844156",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [9, 49],
            [10, 49],
            [10, 50],
            [9, 49],
          ],
        ],
      },
      properties: { "@type": "way", "@id": 25422078, name: "WVV", amenity: "parking" },
    });

    expect(area).toMatchObject({
      osmType: "way",
      osmId: "25422078",
      name: "WVV",
      tags: { name: "WVV", amenity: "parking" },
    });
  });

  it("decodes Osmium area IDs when source attributes are unavailable", () => {
    const wayArea = featureToOsmPoiRecord({
      id: "a200",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [1, 1],
            [2, 1],
            [1, 1],
          ],
        ],
      },
      properties: { name: "Way area" },
    });
    const relationArea = featureToOsmPoiRecord({
      id: "a203",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [1, 1],
            [2, 1],
            [1, 1],
          ],
        ],
      },
      properties: { name: "Relation area" },
    });

    expect(wayArea).toMatchObject({ osmType: "way", osmId: "100" });
    expect(relationArea).toMatchObject({ osmType: "relation", osmId: "101" });
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
