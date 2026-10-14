import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap } from "@/test";
import { AMBIENT_LABEL_LAYER, AmbientPlacesLayer } from "./map-layer";
import { useAmbientPlacesStore } from "./store";

const fake = createFakeMap({ zoom: 16, styleLoaded: true });
const mapRef = { current: fake.map };
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://fixture" }),
}));
vi.mock("@/lib/useExploreReachResults", () => {
  const result = { filtered: [] };
  return { useExploreReachResults: () => result };
});
vi.mock("next-intl", () => ({ useLocale: () => "de" }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fake.state.renderedFeatures.clear();
  fake.state.layers.clear();
  fake.state.sources.clear();
  fake.state.handlers.clear();
  fake.state.zoom = 16;
  useAmbientPlacesStore.setState({ manifest: null, panelOpen: false, layerVisible: true });
  useMapAttributionStore.setState({ byLayer: {} });
});
const credits = () =>
  Object.values(useMapAttributionStore.getState().byLayer)
    .flat()
    .map((entry) => entry.fullHtml)
    .join(" ");
const now = new Date().toISOString();
const publication = {
  version: 2 as const,
  policyVersion: 2,
  generation: "11111111-1111-4111-8111-111111111111",
  publishedAt: now,
  region: { name: "Neuss", bounds: [6.58, 50.89, 7.07, 51.31] as [number, number, number, number] },
  placeCount: 1,
  enabled: true,
  sources: {
    osm: { region: "germany", epoch: "one", publishedAt: now, count: 1 },
    overture: { region: "germany", release: "2026-10-01.0", publishedAt: now, count: 1 },
  },
};
function feature(): MapGeoJSONFeature {
  return {
    type: "Feature",
    source: "ambient-places-source",
    sourceLayer: "ambient_places",
    geometry: { type: "Point", coordinates: [6.7, 51.2] },
    properties: {
      id: "overture:fixture",
      gers_id: "fixture",
      name: "Cafe",
      name_de: "Kaffee",
      category: "cafe",
      min_zoom: 15,
      sources: "overture",
      format_version: 2,
      _mapAttributions: JSON.stringify([
        { sourceId: "meta-places", name: "Hidden name source" },
        { sourceId: "microsoft-places", name: "Captured German name" },
      ]),
      field_contributors: JSON.stringify({
        name: [{ sourceId: "meta-places", name: "Hidden name source" }],
        "names.de": [{ sourceId: "microsoft-places", name: "Captured German name" }],
        gersId: [{ sourceId: "overture", name: "Captured Overture" }],
      }),
    },
    layer: {
      id: AMBIENT_LABEL_LAYER,
      type: "symbol",
      layout: { "text-field": "Kaffee", "text-size": 12 },
      paint: { "text-opacity": 1 },
    },
  } as MapGeoJSONFeature;
}
function start() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ manifest: publication }) })),
  );
  useAmbientPlacesStore.setState({ manifest: publication, panelOpen: true, layerVisible: true });
  return render(<AmbientPlacesLayer />);
}
it("credits the actual placed locale, and removes credits for unrendered and hidden content", async () => {
  const view = start();
  await waitFor(() => expect(fake.map.getLayer(AMBIENT_LABEL_LAYER)).toBeTruthy());
  expect(credits()).toBe("");
  act(() => {
    fake.setRenderedFeatures(AMBIENT_LABEL_LAYER, [feature()]);
    fake.emit("render");
  });
  await waitFor(() => expect(credits()).toContain("Captured German name"));
  expect(credits()).not.toContain("Hidden name source");
  expect(credits()).not.toContain("Foursquare");
  act(() => {
    const transparent = feature();
    transparent.layer.paint = { "text-opacity": 0 };
    fake.setRenderedFeatures(AMBIENT_LABEL_LAYER, [transparent]);
    fake.emit("render");
  });
  await waitFor(() => expect(credits()).toBe(""));
  act(() => {
    fake.setRenderedFeatures(AMBIENT_LABEL_LAYER, []);
    fake.emit("render");
  });
  await waitFor(() => expect(credits()).toBe(""));
  act(() => {
    fake.setRenderedFeatures(AMBIENT_LABEL_LAYER, [feature()]);
    fake.emit("render");
  });
  await waitFor(() => expect(credits()).toContain("Captured German name"));
  act(() => {
    fake.state.zoom = 12;
    fake.emit("idle");
  });
  await waitFor(() => expect(credits()).toBe(""));
  act(() => {
    fake.state.zoom = 16;
    fake.emit("idle");
  });
  await waitFor(() => expect(credits()).toContain("Captured German name"));
  act(() => useAmbientPlacesStore.setState({ layerVisible: false }));
  await waitFor(() => expect(credits()).toBe(""));
  view.unmount();
});
it("credits a suppressed duplicate only through the actual rendered matched basemap feature", async () => {
  fake.map.addLayer({
    id: "base-poi",
    type: "symbol",
    source: "basemap",
    "source-layer": "poi",
    layout: { "text-field": "Kaffee" },
  });
  const source = feature();
  vi.spyOn(fake.map, "querySourceFeatures").mockReturnValue([source]);
  const base = {
    ...source,
    source: "basemap",
    sourceLayer: "poi",
    id: 7,
    properties: { name: "Kaffee", class: "cafe" },
    layer: {
      id: "base-poi",
      type: "symbol",
      layout: { "text-field": "Kaffee" },
      paint: { "text-opacity": 1 },
    },
  } as MapGeoJSONFeature;
  fake.setRenderedFeatures("base-poi", [base]);
  start();
  act(() => fake.emit("idle"));
  await waitFor(() => expect(credits()).toContain("Captured German name"));
  act(() => {
    fake.setRenderedFeatures("base-poi", []);
    fake.emit("render");
  });
  await waitFor(() => expect(credits()).toBe(""));
});
