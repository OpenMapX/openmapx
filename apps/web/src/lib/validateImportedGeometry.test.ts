import { describe, expect, it, vi } from "vitest";
import { parseGeoFile } from "./importGeoFile";

describe("bounded geographic imports", () => {
  it.each([
    { type: "Bogus", coordinates: [8, 50] },
    { type: "Point", coordinates: [181, 50] },
    { type: "Point", coordinates: [8, 91] },
    { type: "Point", coordinates: [null, 50] },
    { type: "LineString", coordinates: [[8, 50]] },
  ])("rejects invalid geometry %j", (geometry) => {
    expect(parseGeoFile("shared.geojson", JSON.stringify(geometry))).toBeNull();
  });
  it("rejects deep collections, huge feature sets and JSON nesting before parsing", () => {
    let geometry: unknown = { type: "Point", coordinates: [8, 50] };
    for (let i = 0; i < 10; i++) geometry = { type: "GeometryCollection", geometries: [geometry] };
    expect(parseGeoFile("shared.geojson", JSON.stringify(geometry))).toBeNull();
    const feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [8, 50] },
    };
    expect(
      parseGeoFile(
        "shared.json",
        JSON.stringify({ type: "FeatureCollection", features: Array(10001).fill(feature) }),
      ),
    ).toBeNull();
    expect(parseGeoFile("shared.json", `${"[".repeat(1000)}0${"]".repeat(1000)}`)).toBeNull();
  });
  it("rejects XML declarations before invoking DOMParser", () => {
    const parser = vi.spyOn(globalThis, "DOMParser");
    try {
      expect(
        parseGeoFile("route.gpx", '<!DOCTYPE gpx [<!ENTITY x "a">]><gpx>&x;</gpx>'),
      ).toBeNull();
      expect(parseGeoFile("route.kml", '<!ENTITY x SYSTEM "https://example.com/">')).toBeNull();
      expect(parser).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
    }
  });
  it("keeps ordinary browser .json and drops remote/executable KML metadata", () => {
    const parsed = parseGeoFile(
      "shared.json",
      JSON.stringify({ type: "Point", coordinates: [8, 50] }),
    );
    expect(parsed?.features).toHaveLength(1);
    const kml =
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><description><![CDATA[<img src="https://tracking.example/">]]></description><Point><coordinates>8,50</coordinates></Point></Placemark></kml>';
    expect(parseGeoFile("shared.kml", kml)?.features[0].properties?.description).toBeUndefined();
  });
});
