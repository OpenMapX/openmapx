import { createTheme, ThemeProvider } from "@mui/material/styles";
import { categoryPlaceToPlace, usePlaceStore } from "@openmapx/core";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";

const fake = createFakeMap({ styleLoaded: true, zoom: 16 });
const mapRef = { current: fake.map };
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://fixture" }),
}));
vi.mock("@/integration-api/overlay/useIntegrationAttribution", () => ({
  useIntegrationAttribution: vi.fn(),
}));
vi.mock("@/lib/useExploreReachResults", () => {
  const result = { filtered: [] };
  return { useExploreReachResults: () => result };
});
vi.mock("next-intl", () => ({ useLocale: () => "en" }));

import {
  AMBIENT_LABEL_LAYER,
  AMBIENT_POINT_LAYER,
  AMBIENT_SOURCE,
  AmbientPlacesLayer,
} from "./map-layer";
import { useAmbientPlacesStore } from "./store";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  usePlaceStore.setState({ selectedPlace: null });
});
describe("ambient suppression with the real group hook", () => {
  it("restores filters after paint-only theme recreation with no subsequent style load", async () => {
    const manifest = {
      version: 1,
      policyVersion: 2,
      generation: "11111111-1111-4111-8111-111111111111",
      publishedAt: new Date().toISOString(),
      enabled: true,
      placeCount: 1,
      region: { name: "Neuss", bounds: [6.58, 50.89, 7.07, 51.31] },
      sources: {
        osm: { region: "Germany", epoch: "one", publishedAt: new Date().toISOString(), count: 1 },
        overture: null,
      },
    };
    const place = {
      id: "osm:way/28562993",
      name: "Quirinus-Münster",
      coordinates: [6.6932, 51.199] as [number, number],
      category: "place_of_worship",
    };
    const feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: place.coordinates },
      properties: { ...place, rank: 2500, min_zoom: 14, tenant: false, sources: "osm" },
    } as MapGeoJSONFeature;
    vi.spyOn(fake.map, "querySourceFeatures").mockReturnValue([feature]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ manifest }) })),
    );
    useAmbientPlacesStore.setState({ panelOpen: true, layerVisible: true, manifest: null });
    usePlaceStore.setState({ selectedPlace: categoryPlaceToPlace(place) });
    const view = render(
      <ThemeProvider theme={createTheme({ palette: { mode: "light" } })}>
        <AmbientPlacesLayer />
      </ThemeProvider>,
    );
    await waitFor(() =>
      expect(JSON.stringify(fake.map.getFilter(AMBIENT_LABEL_LAYER))).toContain(place.id),
    );
    const added = fake.state.counts.addLayer.get(AMBIENT_LABEL_LAYER)!;
    view.rerender(
      <ThemeProvider theme={createTheme({ palette: { mode: "dark" } })}>
        <AmbientPlacesLayer />
      </ThemeProvider>,
    );
    expect(fake.state.counts.addLayer.get(AMBIENT_LABEL_LAYER)).toBeGreaterThan(added);
    act(() => fake.emit("idle"));
    for (const layer of [AMBIENT_POINT_LAYER, AMBIENT_LABEL_LAYER])
      expect(JSON.stringify(fake.map.getFilter(layer))).toContain(place.id);
    const writes = fake.state.counts.setFilter.get(AMBIENT_LABEL_LAYER);
    act(() => {
      fake.emit("idle");
      fake.emit("idle");
    });
    expect(fake.state.counts.setFilter.get(AMBIENT_LABEL_LAYER)).toBe(writes);
    fake.map.removeLayer(AMBIENT_LABEL_LAYER);
    fake.map.addLayer({
      id: AMBIENT_LABEL_LAYER,
      type: "symbol",
      source: AMBIENT_SOURCE,
      "source-layer": "ambient_places",
    });
    act(() => fake.emit("idle"));
    expect(JSON.stringify(fake.map.getFilter(AMBIENT_LABEL_LAYER))).toContain(place.id);
    view.unmount();
    expect(fake.map.getLayer(AMBIENT_LABEL_LAYER)).toBeUndefined();
  });
});
