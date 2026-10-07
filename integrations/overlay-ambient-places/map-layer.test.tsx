import { usePlaceStore } from "@openmapx/core";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const test = vi.hoisted(() => ({
  group: null as unknown,
  map: {
    getLayer: vi.fn(() => true),
    getSource: vi.fn(() => true),
    getZoom: () => 16,
    querySourceFeatures: vi.fn((): MapGeoJSONFeature[] => []),
    queryRenderedFeatures: vi.fn((): MapGeoJSONFeature[] => []),
    getStyle: () => ({ layers: [] }),
    setFilter: vi.fn(),
    on: vi.fn<(event: string, handler: (event?: unknown) => void) => void>(),
    off: vi.fn<(event: string, handler: (event?: unknown) => void) => void>(),
    getCanvas: () => ({ style: { cursor: "" } }),
  },
}));
vi.mock("@/integration-api/map/MapContext", () => {
  const context = { mapRef: { current: test.map }, mapReady: true, styleVersion: 0 };
  return { useMap: () => context };
});
vi.mock("@/integration-api/map/useMapLayerGroup", () => ({
  useMapLayerGroup: (group: unknown) => {
    test.group = group;
  },
}));
vi.mock("@/integration-api/overlay/useIntegrationAttribution", () => ({
  useIntegrationAttribution: vi.fn<(event: string, handler: (event?: unknown) => void) => void>(),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://fixture" }),
}));
vi.mock("@/lib/useExploreReachResults", () => {
  const result = { filtered: [] };
  return { useExploreReachResults: () => result };
});
vi.mock("next-intl", () => ({ useLocale: () => "de" }));

import { AmbientPlacesLayer } from "./map-layer";
import { useAmbientPlacesStore } from "./store";

const manifest = {
  version: 1,
  policyVersion: 1,
  generation: "11111111-1111-4111-8111-111111111111",
  publishedAt: new Date().toISOString(),
  region: { name: "Aachen", bounds: [5.9, 50.65, 6.3, 50.95] },
  placeCount: 1,
  enabled: true,
  sources: {
    osm: { region: "Germany", epoch: "one", publishedAt: new Date().toISOString(), count: 1 },
    overture: null,
  },
};
beforeEach(() => {
  useAmbientPlacesStore.setState({
    panelOpen: true,
    layerVisible: true,
    manifest: null,
    error: false,
    loading: false,
  });
  test.group = null;
  vi.clearAllMocks();
  test.map.querySourceFeatures.mockReturnValue([]);
  test.map.queryRenderedFeatures.mockReturnValue([]);
  usePlaceStore.setState({ selectedPlace: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("ambient generation lifecycle", () => {
  it("uses a bounded generation source and cleans handlers/identity on disable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ manifest }) })),
    );
    const view = render(<AmbientPlacesLayer />);
    await waitFor(() => expect(test.group).not.toBeNull());
    expect(JSON.stringify(test.group)).toContain(manifest.generation);
    expect(JSON.stringify(test.group)).toContain('"maxzoom":18');
    act(() => useAmbientPlacesStore.setState({ layerVisible: false }));
    await waitFor(() => expect(test.group).toBeNull());
    view.unmount();
    expect(test.map.off).toHaveBeenCalled();
  });
  it("ignores late discovery after disable and leaves no-data browsing intact", async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );
    render(<AmbientPlacesLayer />);
    act(() => useAmbientPlacesStore.setState({ layerVisible: false }));
    await act(async () => resolve({ ok: true, json: async () => ({ manifest }) }));
    expect(test.group).toBeNull();
    expect(useAmbientPlacesStore.getState().manifest).toBeNull();
  });
  it("opens the canonical tile identity, suppresses its selected marker and reapplies filters after style replacement", async () => {
    const feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [6.08, 50.77] },
      properties: {
        id: "osm:node/9007199254740993",
        gers_id: "gers-a",
        name: "Clinic",
        name_de: "Klinik",
        category: "amenity:hospital",
        rank: 800,
        min_zoom: 13,
        tenant: false,
        sources: "osm,overture",
      },
    } as MapGeoJSONFeature;
    test.map.querySourceFeatures.mockReturnValue([feature]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ manifest }) })),
    );
    render(<AmbientPlacesLayer />);
    await waitFor(() => expect(test.group).not.toBeNull());
    const handlers = () =>
      Object.fromEntries(
        test.map.on.mock.calls.map(([event, handler]) => [event, handler]),
      ) as Record<string, (event?: unknown) => void>;
    test.map.queryRenderedFeatures.mockReturnValue([feature]);
    act(() => handlers().click({ point: { x: 1, y: 2 } }));
    expect(usePlaceStore.getState().selectedPlace).toMatchObject({
      id: "osm:node/9007199254740993",
      ids: { gers: "gers-a", overture: "gers-a" },
      name: "Klinik",
    });
    await waitFor(() =>
      expect(JSON.stringify(test.map.setFilter.mock.calls.at(-1))).toContain(
        "osm:node/9007199254740993",
      ),
    );
    const prior = test.map.setFilter.mock.calls.length;
    act(() => {
      handlers()["style.load"]();
      handlers().idle();
    });
    expect(test.map.setFilter.mock.calls.length).toBeGreaterThan(prior);
  });
  it("removes a disabled publication without resurrecting the previous generation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ manifest: { ...manifest, enabled: false } }),
      })),
    );
    render(<AmbientPlacesLayer />);
    await waitFor(() => expect(useAmbientPlacesStore.getState().loading).toBe(false));
    expect(test.group).toBeNull();
  });
});
