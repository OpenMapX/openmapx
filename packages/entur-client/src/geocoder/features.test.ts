import { describe, expect, it } from "vitest";
import type { EnturGeocoderFeature } from "./client";
import {
  geocoderFeatureCoordinates,
  geocoderFeatureIdentity,
  geocoderFeatureModes,
} from "./features";
import { enturGeocoderCoverage, normalizeEnturGeocoderCountry } from "./sources";

function feature(
  properties: Partial<EnturGeocoderFeature["properties"]> = {},
  coordinates = [10, 60],
): EnturGeocoderFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: {
      id: "NSR:StopPlace:337",
      names: { default: "Oslo S", display: "Oslo S, Oslo" },
      layer: "stopPlace",
      source: "nsr",
      ...properties,
    },
  };
}
describe("native geocoder primitives", () => {
  it.each([
    ["stopPlace", "NSR:StopPlace:337", "nsr", { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" }],
    [
      "groupOfStopPlaces",
      "NSR:GroupOfStopPlaces:1",
      "nsr",
      { entur: "NSR:GroupOfStopPlaces:1", nsr: "GroupOfStopPlaces:1" },
    ],
    ["poi", "OSM:TopographicPlace:22", "entur", { entur: "OSM:TopographicPlace:22" }],
    ["address", "KVE:PostalAddress:225678815", "entur", { entur: "KVE:PostalAddress:225678815" }],
    [
      "street",
      "KVE:TopographicPlace:0301-STREET",
      "entur",
      { entur: "KVE:TopographicPlace:0301-STREET" },
    ],
    ["place", "KVE:PlaceName:434810", "entur", { entur: "KVE:PlaceName:434810" }],
  ] as const)(
    "retains %s identity without translating native IDs",
    (layer, id, primaryScheme, ids) => {
      expect(geocoderFeatureIdentity(feature({ layer, id }))).toEqual({
        nativeId: id,
        primaryScheme,
        ids,
      });
    },
  );
  it.each([
    [180, 90],
    [-180, -90],
    [0, 0],
  ])("accepts WGS84 boundaries %j", (lon, lat) => {
    expect(geocoderFeatureCoordinates(feature({}, [lon, lat]))).toEqual([lon, lat]);
  });
  it.each([[181, 0], [0, 91], [NaN, 0], [0, Infinity], [0], [0, 0, 0]])(
    "rejects invalid coordinates %j",
    (...coordinates) => {
      expect(geocoderFeatureCoordinates(feature({}, coordinates))).toBeUndefined();
    },
  );
  it("deduplicates known native modes and stop types without inventing unknown modes", () => {
    expect(
      geocoderFeatureModes(
        feature({
          transportModes: [
            { mode: "rail", subMode: "local" },
            { mode: "metro" },
            { mode: "water" },
            { mode: "coach" },
            { mode: "cableway" },
            { mode: "unknown" },
          ],
          stopPlaceTypes: ["railStation", "busStation", "liftStation", "tramStation", "unknown"],
        }),
      ),
    ).toEqual(["rail", "subway", "ferry", "bus", "cable_car", "gondola", "tram"]);
    expect(
      geocoderFeatureModes(
        feature({
          transportModes: [{ mode: "air" }, { mode: "unknown" }],
          stopPlaceTypes: ["unknown", "airport"],
        }),
      ),
    ).toEqual([]);
    expect(geocoderFeatureModes(feature())).toEqual([]);
  });
});
describe("country configuration", () => {
  it("defaults only undefined, preserves explicit empty and lowercase ISO2", () => {
    expect(normalizeEnturGeocoderCountry(undefined)).toBe("no");
    expect(normalizeEnturGeocoderCountry("")).toBe("");
    expect(normalizeEnturGeocoderCountry("se")).toBe("se");
  });
  it.each(["NOR", "SWE", "NO", " no", "no ", "a", "nø", null, false, 0])(
    "rejects invalid country %j",
    (value) => {
      expect(() => normalizeEnturGeocoderCountry(value)).toThrow();
    },
  );
  it("detaches coverage from caller mutation", () => {
    const no = enturGeocoderCoverage("no");
    if (!no) throw new Error("Expected Norway coverage");
    no[0] = 0;
    expect(enturGeocoderCoverage("no")).toEqual([4, 57.5, 32, 72]);
    expect(enturGeocoderCoverage("se")).toEqual([10.5, 55, 24.5, 69.5]);
    expect(enturGeocoderCoverage("")).toBeUndefined();
    expect(enturGeocoderCoverage("de")).toBeUndefined();
  });
});
