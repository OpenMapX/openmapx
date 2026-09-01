// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/map/MapContext", () => {
  const context = {
    mapRef: { current: null as unknown },
    mapReady: true,
    styleVersion: 0,
  };
  return { __test: context, useMap: () => context };
});

import { PANEL, usePlaceStore, useSidebarStore } from "@openmapx/core";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import * as mapContext from "@/integration-api/map/MapContext";
import { MapStylePoiClickHandler } from "./MapStylePoiClickHandler";

const mapContextTest = (mapContext as unknown as { __test: { mapRef: { current: unknown } } })
  .__test;
const initialInteractiveLayerIds = new Set(INTERACTIVE_LAYER_IDS);

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

class FakeMap {
  readonly handlers = new Map<string, Set<(event: never) => void>>();
  readonly canvas = document.createElement("div");

  constructor(
    private featuresByLayer: Record<string, MapGeoJSONFeature[]>,
    private readonly styleLayers = [{ id: "poi-label", type: "symbol", "source-layer": "poi" }],
  ) {}

  getStyle = () => ({ layers: this.styleLayers });
  getLayer = (id: string) =>
    this.featuresByLayer[id] || this.styleLayers.some((layer) => layer.id === id)
      ? { id }
      : undefined;
  getCanvasContainer = () => this.canvas;
  on = (event: string, handler: (event: never) => void) => {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  };
  off = (event: string, handler: (event: never) => void) => {
    this.handlers.get(event)?.delete(handler);
  };
  queryRenderedFeatures = (_point: unknown, options: { layers?: string[] }) =>
    options.layers?.flatMap((id) => this.featuresByLayer[id] ?? []) ?? [];
  setFeatures(featuresByLayer: Record<string, MapGeoJSONFeature[]>) {
    this.featuresByLayer = featuresByLayer;
  }
  addStyleLayer(layer: { id: string; type: string; "source-layer": string }) {
    this.styleLayers.push(layer);
  }
  emit(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload as never);
  }
}

function renderHandler(map: FakeMap) {
  mapContextTest.mapRef.current = map;
  return render(<MapStylePoiClickHandler />);
}

beforeEach(() => {
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  INTERACTIVE_LAYER_IDS.clear();
});

afterEach(() => {
  mapContextTest.mapRef.current = null;
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  INTERACTIVE_LAYER_IDS.clear();
  for (const id of initialInteractiveLayerIds) INTERACTIVE_LAYER_IDS.add(id);
});

describe("MapStylePoiClickHandler", () => {
  it("selects a named style POI and opens the place sidebar", () => {
    const fake = new FakeMap({
      "poi-label": [
        pointFeature(
          { name: "Smithsonian Institution Building", class: "culture", subclass: "museum" },
          { id: 42 },
        ),
      ],
    });
    renderHandler(fake);

    act(() => {
      fake.emit("click", {
        point: { x: 12, y: 24 },
        lngLat: { lng: -77.02573, lat: 38.88859 },
      });
    });

    expect(usePlaceStore.getState().selectedPlace).toMatchObject({
      id: "stylePoi:42",
      name: "Smithsonian Institution Building",
      address: "Smithsonian Institution Building",
      coordinates: [-77.02573, 38.88859],
      category: "museum",
      rawCategory: "culture/museum",
    });
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
  });

  it("preserves an active category sidebar and opens the place card", () => {
    const fake = new FakeMap({ "poi-label": [pointFeature({ name: "Smithsonian" })] });
    useSidebarStore.setState({ activeSidebarId: PANEL.CATEGORY });
    renderHandler(fake);

    act(() => fake.emit("click", { point: { x: 12, y: 24 } }));

    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
    expect(useSidebarStore.getState().activeDetailId).toBe(PANEL.PLACE_CARD);
  });

  it("does not select a POI when an interactive overlay is hit", () => {
    const fake = new FakeMap({
      "poi-label": [pointFeature({ name: "Smithsonian" })],
      "category-results-layer": [pointFeature({ name: "Result" })],
    });
    INTERACTIVE_LAYER_IDS.add("category-results-layer");
    renderHandler(fake);

    act(() => fake.emit("click", { point: { x: 12, y: 24 } }));

    expect(usePlaceStore.getState().selectedPlace).toBeNull();
  });

  it("sets the pointer cursor only over a named POI", () => {
    const fake = new FakeMap({ "poi-label": [pointFeature({ name: "Smithsonian" })] });
    renderHandler(fake);

    act(() => fake.emit("mousemove", { point: { x: 12, y: 24 } }));
    expect(fake.canvas.style.cursor).toBe("pointer");

    fake.setFeatures({ "poi-label": [pointFeature({})] });
    act(() => fake.emit("mousemove", { point: { x: 12, y: 24 } }));
    expect(fake.canvas.style.cursor).toBe("");
  });

  it("refreshes registered POI layer ids on styledata", () => {
    const fake = new FakeMap({}, []);
    renderHandler(fake);
    expect(INTERACTIVE_LAYER_IDS.has("poi-label")).toBe(false);

    fake.addStyleLayer({ id: "poi-label", type: "symbol", "source-layer": "poi" });
    act(() => fake.emit("styledata"));

    expect(INTERACTIVE_LAYER_IDS.has("poi-label")).toBe(true);
  });

  it("removes handlers and registered layer ids on unmount", () => {
    const fake = new FakeMap({ "poi-label": [pointFeature({ name: "Smithsonian" })] });
    const view = renderHandler(fake);
    expect(INTERACTIVE_LAYER_IDS.has("poi-label")).toBe(true);

    view.unmount();

    expect(INTERACTIVE_LAYER_IDS.has("poi-label")).toBe(false);
    expect([...fake.handlers.values()].every((handlers) => handlers.size === 0)).toBe(true);
  });
});
