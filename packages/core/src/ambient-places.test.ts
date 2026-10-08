import { describe, expect, it } from "vitest";
import {
  ambientCategory,
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
  it("does not turn uncategorized indexed roads or buildings into ambient destinations", () => {
    expect(
      ambientPlaceFromOsm({
        ...osm,
        category: null,
        tags: { name: "Industriestraße", loc_name: "Hafenmole", highway: "unclassified" },
      }),
    ).toBeNull();
    expect(ambientPlaceFromOsm({ ...osm, category: "", tags: { building: "yes" } })).toBeNull();
    expect(
      ambientPlaceFromOsm({ ...osm, category: "amenity/library", tags: { building: "yes" } }),
    ).not.toBeNull();
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
  it("normalizes indexed slash categories and legacy colon categories identically", () => {
    for (const prefix of ["amenity/", "amenity:"]) {
      expect(ambientCategory(`${prefix}hospital`)).toBe("hospital");
      expect(ambientPlaceFromOsm({ ...osm, category: `${prefix}hospital` })!.minZoom).toBe(13);
    }
    expect(ambientPlaceFromOsm({ ...osm, category: "shop/bakery" })!.minZoom).toBe(15);
    expect(ambientPlaceFromOsm({ ...osm, category: "shop/books" })!.minZoom).toBe(15);
  });
  it("promotes only corroborated cultural landmarks and preserves exclusion/tenant policy", () => {
    const base = { ...osm, category: "amenity/place_of_worship" };
    const regional = { wikidata: "Q156475", heritage: "4" };
    const designated = { wikidata: "Q156475", basilica: "yes" };
    expect(ambientPlaceFromOsm({ ...base, tags: regional })!.minZoom).toBe(15);
    expect(ambientPlaceFromOsm({ ...base, tags: designated })!.minZoom).toBe(14);
    expect(
      ambientPlaceFromOsm({ ...base, tags: { heritage: "1", wikipedia: "de:Dom" } })!.minZoom,
    ).toBe(14);
    const controls: Record<string, string>[] = [
      {},
      { wikidata: "Q156475" },
      { heritage: "4" },
      { wikidata: "Q156475", heritage: "no" },
      { wikidata: "bad", heritage: "4" },
      { wikipedia: "no-prefix", heritage: "4" },
      { wikidata: "Q156475", heritage: "0" },
    ];
    for (const tags of controls) {
      expect(ambientPlaceFromOsm({ ...base, tags })!.minZoom).toBe(16);
    }
    expect(ambientPlaceFromOsm({ ...base, tags: { ...designated, level: "1" } })!.minZoom).toBe(18);
    expect(ambientPlaceFromOsm({ ...base, tags: { ...designated, access: "private" } })).toBeNull();
    expect(ambientPlaceFromOsm({ ...base, tags: { ...designated, disused: "yes" } })).toBeNull();
    expect(ambientPlaceFromOsm({ ...base, category: "shop/books", tags: regional })!.minZoom).toBe(
      15,
    );
    expect(
      ambientPlaceFromOsm({ ...base, category: "amenity/bench", tags: regional })!.minZoom,
    ).toBe(16);
    const landmark = ambientPlaceFromOsm({ ...base, tags: designated })!;
    expect(landmark.rank).toBeGreaterThan(
      ambientPlaceFromOsm({ ...osm, category: "shop/bakery" })!.rank,
    );
    expect(landmark.rank).toBeLessThan(ambientPlaceFromOsm(osm)!.rank);
  });
  it("reads legacy serialized tags and rejects malformed/non-object policy inputs", () => {
    const legacy = {
      ...osm,
      category: "amenity/place_of_worship",
      tags: JSON.stringify({ wikidata: "Q896410", basilica: "minor" }),
    };
    expect(ambientPlaceFromOsm(legacy as never)!.minZoom).toBe(14);
    expect(
      ambientPlaceFromOsm({ ...legacy, tags: JSON.stringify({ access: "private" }) } as never),
    ).toBeNull();
    for (const tags of ["not-json", "[]", "null", { access: true }]) {
      expect(ambientPlaceFromOsm({ ...osm, tags } as never)).toBeNull();
    }
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
  it("matches alternate landmark representative points within ten metres conservatively", () => {
    const a = {
      ...ambientPlaceFromOsm(osm)!,
      id: "osm:way/28562993",
      name: "Quirinus-Münster",
      names: {},
      category: "place_of_worship",
      coordinates: [6.6933392733335495, 51.19904645716551] as [number, number],
    };
    const label = {
      key: "base/quirinus",
      name: a.name,
      category: "place_of_worship",
      coordinates: [6.693227291107178, 51.19902166658045] as [number, number],
    };
    expect(matchAmbientBasemap([a], [label]).get(label.key)?.id).toBe(a.id);
    expect(matchAmbientBasemap([a, { ...a, id: "osm:way/2" }], [label]).size).toBe(0);
    expect(matchAmbientBasemap([{ ...a, tenant: true }], [label]).size).toBe(0);
    expect(matchAmbientBasemap([a], [{ ...label, coordinates: [6.6931, 51.199] }]).size).toBe(0);
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
