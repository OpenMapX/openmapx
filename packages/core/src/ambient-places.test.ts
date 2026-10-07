import { describe, expect, it } from "vitest";
import {
  ambientPlaceFromOsm,
  ambientPlaceFromOverture,
  ambientPlaceToCategoryPlace,
  matchAmbientBasemap,
  mergeAmbientPlaces,
  validateAmbientRegion,
} from "./ambient-places";

const osm = {
  osm_type: "node",
  osm_id: "9007199254740993",
  name: "Klinik",
  lng: 6.08,
  lat: 50.77,
  category: "amenity:hospital",
  importance: 0.8,
  tags: { "name:en": "Clinic" },
};
const overture = {
  gers_id: "gers-a",
  name: "Clinic",
  longitude: 6.08,
  latitude: 50.77,
  basic_category: "hospital",
  names: { common: { de: "Krankenhaus" } },
  confidence: 0.8,
  operating_status: "open",
};

describe("ambient place policy", () => {
  it("accepts a bounded Aachen region and rejects arbitrary/planet inputs", () => {
    expect(validateAmbientRegion({ name: "Aachen", bounds: [5.9, 50.65, 6.3, 50.95] }).name).toBe(
      "Aachen",
    );
    for (const bounds of [
      [5, 50, 6, 51],
      [6, 50, 7, 50.1],
      [6, 50, 6, 50.1],
      [6, NaN, 6.1, 50.1],
    ]) {
      expect(() => validateAmbientRegion({ name: "region", bounds })).toThrow();
    }
  });
  it("keeps bigint identity and original/localized labels without guessing", () => {
    const place = ambientPlaceFromOsm(osm)!;
    expect(place.id).toBe("osm:node/9007199254740993");
    expect(ambientPlaceToCategoryPlace(place, "en").name).toBe("Clinic");
    expect(ambientPlaceToCategoryPlace(place, "fr").name).toBe("Klinik");
    expect(ambientPlaceFromOsm({ ...osm, name: "a".repeat(121) })!.name).toHaveLength(120);
  });
  it("excludes closed/private OSM and uncertain/closed Overture", () => {
    for (const tags of [
      { disused: "yes" },
      { access: "private" },
      { "abandoned:amenity": "hospital" },
      { "disused:shop": "bakery" },
    ] as Record<string, string>[]) {
      expect(ambientPlaceFromOsm({ ...osm, tags })).toBeNull();
    }
    for (const patch of [
      { confidence: 0.49 },
      { confidence: null },
      { operating_status: "permanently_closed" },
      { operating_status: "temporarily_closed" },
      { operating_status: null },
    ]) {
      expect(ambientPlaceFromOverture({ ...overture, ...patch })).toBeNull();
    }
    expect(ambientPlaceFromOverture({ ...overture, confidence: 0.5 })).not.toBeNull();
  });
  it("ranks useful categories first and defers tenants to zoom 18", () => {
    expect(ambientPlaceFromOsm(osm)!.minZoom).toBe(13);
    expect(ambientPlaceFromOsm({ ...osm, category: "shop:bakery" })!.minZoom).toBe(15);
    expect(ambientPlaceFromOsm({ ...osm, category: "tourism:artwork" })!.minZoom).toBe(16);
    expect(ambientPlaceFromOsm({ ...osm, tags: { level: "1" } })!.minZoom).toBe(18);
  });
  it("fuses only accepted links, preserves OSM location and survives excluded Overture", () => {
    const a = ambientPlaceFromOsm(osm)!;
    const b = ambientPlaceFromOverture(overture)!;
    const fused = mergeAmbientPlaces([a], [b], new Map([[a.id, b.gersId!]]));
    expect(fused).toHaveLength(1);
    expect(fused[0]).toMatchObject({
      id: a.id,
      gersId: "gers-a",
      name: "Klinik",
      coordinates: [6.08, 50.77],
      sources: "osm,overture",
    });
    expect(fused[0].names.de).toBe("Krankenhaus");
    expect(mergeAmbientPlaces([a], [b], new Map())).toHaveLength(2);
    expect(mergeAmbientPlaces([a], [], new Map([[a.id, "gers-a"]]))[0].gersId).toBe("gers-a");
  });
  it("never replaces an explicit different basemap OSM identity through proximity", () => {
    const a = ambientPlaceFromOsm(osm)!;
    const label = {
      key: "base/other",
      name: a.name,
      category: a.category,
      coordinates: a.coordinates,
      osmId: "osm:node/2",
    };
    expect(matchAmbientBasemap([a], [label]).size).toBe(0);
    expect(matchAmbientBasemap([a], [{ ...label, osmId: a.id }]).get(label.key)?.id).toBe(a.id);
  });
  it("matches unique nearby compatible basemap labels and refuses branches and tenants", () => {
    const a = ambientPlaceFromOsm(osm)!;
    const label = {
      key: "base/1",
      name: "Klinik",
      coordinates: [6.08, 50.77] as [number, number],
      category: "hospital",
    };
    expect(matchAmbientBasemap([a], [label]).get(label.key)?.id).toBe(a.id);
    expect(matchAmbientBasemap([a, { ...a, id: "osm:node/2" }], [label]).size).toBe(0);
    expect(matchAmbientBasemap([{ ...a, tenant: true }], [label]).size).toBe(0);
    expect(matchAmbientBasemap([a], [{ ...label, category: "restaurant" }]).size).toBe(0);
    expect(matchAmbientBasemap([a], [{ ...label, coordinates: [6.081, 50.77] }]).size).toBe(0);
  });
});

describe("accepted-link gap-fill identity", () => {
  it("keeps canonical identity when only GERS is in the regional view, and suppresses a known closed OSM match", () => {
    const p = ambientPlaceFromOverture(overture)!;
    const links = new Map([["osm:node/9007199254740993", "gers-a"]]);
    expect(mergeAmbientPlaces([], [p], links)[0].id).toBe("osm:node/9007199254740993");
    expect(mergeAmbientPlaces([], [p], links, new Set(["osm:node/9007199254740993"]))).toEqual([]);
  });
});
