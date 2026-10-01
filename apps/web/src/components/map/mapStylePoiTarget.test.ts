import type { MapGeoJSONFeature, Map as MaplibreMap, PointLike } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  filterWithoutFeature,
  findStylePoiAtPoint,
  findStylePoiFeatureId,
  getStylePoiLayerIds,
} from "./mapStylePoiTarget";

const point = { x: 12, y: 24 } as unknown as PointLike;

function pointFeature(
  properties: Record<string, unknown>,
  options: { id?: string | number; coordinates?: [number, number] } = {},
): MapGeoJSONFeature {
  return {
    type: "Feature",
    id: options.id,
    geometry: { type: "Point", coordinates: options.coordinates ?? [-77.02573, 38.88859] },
    properties,
    layer: { id: "poi-label", type: "symbol" },
    source: "openmaptiles",
    sourceLayer: "poi",
    state: {},
  } as unknown as MapGeoJSONFeature;
}

function makeHitMap(featuresByLayer: Record<string, MapGeoJSONFeature[]>) {
  return {
    getLayer: (id: string) => (featuresByLayer[id] ? { id } : undefined),
    queryRenderedFeatures: (_point: unknown, options: { layers?: string[] }) =>
      options.layers?.flatMap((id) => featuresByLayer[id] ?? []) ?? [],
  } as unknown as MaplibreMap;
}

describe("mapStylePoiTarget", () => {
  it("discovers only basemap POI symbol layers", () => {
    const map = {
      getStyle: () => ({
        layers: [
          { id: "poi-label", type: "symbol", "source-layer": "poi" },
          { id: "road-label", type: "symbol", "source-layer": "transportation_name" },
          { id: "poi-circle", type: "circle", "source-layer": "poi" },
          { id: "category-results-labels", type: "symbol", "source-layer": "poi" },
          { id: "poi-transit-stop-labels", type: "symbol", source: "transit-stop-labels" },
        ],
      }),
    } as unknown as MaplibreMap;

    // The stop labels re-publish basemap stops, so a click on a name opens the stop.
    expect(getStylePoiLayerIds(map)).toEqual(["poi-label", "poi-transit-stop-labels"]);
  });

  it("maps the top named point to the shared target shape", () => {
    const feature = pointFeature(
      { name: "Smithsonian Institution Building", class: "culture", subclass: "museum" },
      { id: 42 },
    );
    const map = makeHitMap({ "poi-label": [feature] });

    expect(findStylePoiAtPoint(map, point, ["poi-label"], new Set())).toEqual({
      featureId: "42",
      name: "Smithsonian Institution Building",
      coordinates: [-77.02573, 38.88859],
      category: "museum",
      rawCategory: "culture/museum",
    });
  });

  it("returns null when an interactive overlay is hit", () => {
    const map = makeHitMap({
      "poi-label": [pointFeature({ name: "Smithsonian" })],
      "category-results-layer": [pointFeature({ name: "Result" })],
    });

    expect(
      findStylePoiAtPoint(map, point, ["poi-label"], new Set(["category-results-layer"])),
    ).toBeNull();
  });

  it("does not treat a POI layer as an overlay", () => {
    const map = makeHitMap({ "poi-label": [pointFeature({ name: "Smithsonian" })] });

    expect(findStylePoiAtPoint(map, point, ["poi-label"], new Set(["poi-label"]))).toMatchObject({
      name: "Smithsonian",
    });
  });

  it("takes the label's localized name over the local one", () => {
    const map = makeHitMap({
      "poi-label": [
        pointFeature({ name: "Berliner Fernsehturm", "name:en": "Fernsehturm Berlin" }),
      ],
    });

    expect(findStylePoiAtPoint(map, point, ["poi-label"], new Set(), "en")).toMatchObject({
      name: "Fernsehturm Berlin",
    });
    expect(findStylePoiAtPoint(map, point, ["poi-label"], new Set(), "fr")).toMatchObject({
      name: "Berliner Fernsehturm",
    });
  });

  it("returns null for unnamed features", () => {
    const map = makeHitMap({ "poi-label": [pointFeature({ class: "culture" })] });

    expect(findStylePoiAtPoint(map, point, ["poi-label"], new Set())).toBeNull();
  });

  it("returns null for non-point features", () => {
    const feature = {
      ...pointFeature({ name: "Smithsonian" }),
      geometry: { type: "LineString", coordinates: [] },
    } as unknown as MapGeoJSONFeature;
    const map = makeHitMap({ "poi-label": [feature] });

    expect(findStylePoiAtPoint(map, point, ["poi-label"], new Set())).toBeNull();
  });

  it("returns null when no POI layer is live", () => {
    const map = makeHitMap({});

    expect(findStylePoiAtPoint(map, point, ["poi-label"], new Set())).toBeNull();
  });

  it("uses subclass alone as the raw category when class is absent", () => {
    const map = makeHitMap({
      "poi-label": [pointFeature({ name: "Smithsonian", subclass: "museum" })],
    });

    expect(findStylePoiAtPoint(map, point, ["poi-label"], new Set())).toMatchObject({
      category: "museum",
      rawCategory: "museum",
    });
  });

  it("derives a coordinate id when the feature id is missing", () => {
    const map = makeHitMap({ "poi-label": [pointFeature({ name: "Smithsonian" })] });

    expect(findStylePoiAtPoint(map, point, ["poi-label"], new Set())).toMatchObject({
      featureId: "-77.02573-38.88859",
    });
  });
});

describe("findStylePoiFeatureId", () => {
  const tower: [number, number] = [13.40942, 52.52082];

  function sourceMap(features: MapGeoJSONFeature[]) {
    const queried: Array<{ source: string; sourceLayer?: string }> = [];
    const map = {
      getStyle: () => ({
        layers: [
          { id: "poi-level-1", type: "symbol", source: "openmaptiles", "source-layer": "poi" },
          { id: "road-label", type: "symbol", source: "openmaptiles", "source-layer": "road" },
        ],
      }),
      querySourceFeatures: (source: string, options: { sourceLayer?: string }) => {
        queried.push({ source, sourceLayer: options.sourceLayer });
        return features;
      },
    } as unknown as MaplibreMap;
    return { map, queried };
  }

  it("takes a clicked POI's tile id without searching", () => {
    const { map, queried } = sourceMap([]);

    expect(
      findStylePoiFeatureId(map, ["poi-level-1"], {
        coordinates: tower,
        names: ["Fernsehturm Berlin"],
        stylePoiId: "5564352411",
      }),
    ).toBe(5564352411);
    expect(queried).toEqual([]);
  });

  it("matches the nearest POI carrying one of the place's names in any language", () => {
    const { map, queried } = sourceMap([
      pointFeature({ name: "Espresso House" }, { id: 1, coordinates: [13.4096, 52.52085] }),
      pointFeature(
        { name: "Berliner Fernsehturm", "name:en": "Fernsehturm Berlin" },
        { id: 2, coordinates: [13.40945, 52.5208] },
      ),
    ]);

    expect(
      findStylePoiFeatureId(map, ["poi-level-1"], {
        coordinates: tower,
        names: ["fernsehturm berlin"],
      }),
    ).toBe(2);
    expect(queried).toEqual([{ source: "openmaptiles", sourceLayer: "poi" }]);
  });

  it("ignores a same-named POI that is not the selected place", () => {
    const { map } = sourceMap([
      pointFeature({ name: "Starbucks" }, { id: 3, coordinates: [13.42, 52.5208] }),
    ]);

    expect(
      findStylePoiFeatureId(map, ["poi-level-1"], { coordinates: tower, names: ["Starbucks"] }),
    ).toBeNull();
  });
});

describe("filterWithoutFeature", () => {
  it("adds an expression clause to an expression filter", () => {
    expect(filterWithoutFeature(["has", "name"], 7)).toEqual([
      "all",
      ["has", "name"],
      ["!=", ["id"], 7],
    ]);
    expect(filterWithoutFeature(["==", ["get", "class"], "park"], 7)).toEqual([
      "all",
      ["==", ["get", "class"], "park"],
      ["!=", ["id"], 7],
    ]);
  });

  it("keeps a legacy filter in legacy syntax, which cannot mix with expressions", () => {
    const legacy = ["all", ["==", "$type", "Point"], ["==", "class", "park"]];

    expect(filterWithoutFeature(legacy as never, 7)).toEqual(["all", legacy, ["!=", "$id", 7]]);
  });

  it("filters out just the feature when the layer has no filter", () => {
    expect(filterWithoutFeature(undefined, 7)).toEqual(["!=", ["id"], 7]);
  });
});
