// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap } from "@/test/fakeMap";

vi.mock("@/integration-api/map/MapContext", () => {
  const context = { mapRef: { current: null as unknown }, mapReady: true, styleVersion: 0 };
  return { __test: context, useMap: () => context };
});

import * as mapContext from "@/integration-api/map/MapContext";
import { type HiddenStylePoiPlace, useHiddenStylePoi } from "./useHiddenStylePoi";

const mapContextTest = (mapContext as unknown as { __test: { mapRef: { current: unknown } } })
  .__test;

const EXPRESSION_FILTER = ["has", "name"];
const LEGACY_FILTER = ["==", "class", "railway"];

const POI_LAYERS = [
  { id: "poi-level-1", type: "symbol", source: "openmaptiles", "source-layer": "poi" },
  { id: "poi-railway", type: "symbol", source: "openmaptiles", "source-layer": "poi" },
];

function poiMap(): FakeMap {
  const fake = createFakeMap({ baseLayers: POI_LAYERS });
  fake.state.filters.set("poi-level-1", EXPRESSION_FILTER);
  fake.state.filters.set("poi-railway", LEGACY_FILTER);
  mapContextTest.mapRef.current = fake.map;
  return fake;
}

function fountain(id: number): MapGeoJSONFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [13.40657, 52.51927] },
    properties: { name: "Neptunbrunnen" },
  } as unknown as MapGeoJSONFeature;
}

const CLICKED: HiddenStylePoiPlace = {
  coordinates: [13.40942, 52.52082],
  names: ["Fernsehturm Berlin"],
  stylePoiId: "5564352411",
};

afterEach(() => {
  mapContextTest.mapRef.current = null;
});

describe("useHiddenStylePoi", () => {
  it("leaves the selected POI out of every basemap POI layer, in each layer's syntax", () => {
    const fake = poiMap();

    renderHook(() => useHiddenStylePoi(CLICKED));

    expect(fake.state.filters.get("poi-level-1")).toEqual([
      "all",
      EXPRESSION_FILTER,
      ["!=", ["id"], 5564352411],
    ]);
    expect(fake.state.filters.get("poi-railway")).toEqual([
      "all",
      LEGACY_FILTER,
      ["!=", "$id", 5564352411],
    ]);
  });

  it("puts the style's own filters back on deselection", () => {
    const fake = poiMap();
    const view = renderHook(({ place }) => useHiddenStylePoi(place), {
      initialProps: { place: CLICKED as HiddenStylePoiPlace | null },
    });

    view.rerender({ place: null });

    expect(fake.state.filters.get("poi-level-1")).toEqual(EXPRESSION_FILTER);
    expect(fake.state.filters.get("poi-railway")).toEqual(LEGACY_FILTER);
  });

  it("does not re-narrow a filter it already narrowed", () => {
    const fake = poiMap();
    renderHook(() => useHiddenStylePoi(CLICKED));
    const before = fake.state.counts.setFilter.get("poi-level-1");

    fake.emit("styledata");

    expect(fake.state.counts.setFilter.get("poi-level-1")).toBe(before);
  });

  it("narrows the filter again after a style change resets it", () => {
    const fake = poiMap();
    renderHook(() => useHiddenStylePoi(CLICKED));

    fake.state.filters.set("poi-level-1", EXPRESSION_FILTER);
    fake.emit("styledata");

    expect(fake.state.filters.get("poi-level-1")).toEqual([
      "all",
      EXPRESSION_FILTER,
      ["!=", ["id"], 5564352411],
    ]);
  });

  it("finds a searched place's POI once its tile has loaded", () => {
    const fake = poiMap();
    let loaded: MapGeoJSONFeature[] = [];
    (
      fake.map as unknown as { querySourceFeatures: () => MapGeoJSONFeature[] }
    ).querySourceFeatures = () => loaded;
    renderHook(() =>
      useHiddenStylePoi({ coordinates: [13.40665, 52.51935], names: ["Neptunbrunnen"] }),
    );
    expect(fake.state.filters.get("poi-level-1")).toEqual(EXPRESSION_FILTER);

    loaded = [fountain(238132041)];
    fake.emit("idle");

    expect(fake.state.filters.get("poi-level-1")).toEqual([
      "all",
      EXPRESSION_FILTER,
      ["!=", ["id"], 238132041],
    ]);
  });
});
