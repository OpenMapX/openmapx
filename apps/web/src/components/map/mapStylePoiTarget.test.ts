import type { MapGeoJSONFeature, Map as MaplibreMap, PointLike } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { findStylePoiAtPoint, getStylePoiLayerIds } from "./mapStylePoiTarget";

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
        ],
      }),
    } as unknown as MaplibreMap;

    expect(getStylePoiLayerIds(map)).toEqual(["poi-label"]);
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
