import { createRequire } from "node:module";
import { resolve } from "node:path";
import { usePlaceStore } from "@openmapx/core";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webRequire = createRequire(resolve(process.cwd(), "apps/web/package.json"));
const rendererRequire = createRequire(webRequire.resolve("maplibre-gl/package.json"));
const { createExpression, latest } = rendererRequire("@maplibre/maplibre-gl-style-spec") as {
  latest: { layout_symbol: Record<string, unknown> };
  createExpression: (
    value: unknown,
    rootKey: string,
    specification: unknown,
  ) => {
    result: string;
    value: {
      evaluate: (
        globals: { zoom: number },
        feature: { type: string; properties: Record<string, unknown>; geometry: never[] },
      ) => unknown;
    };
  };
};

const test = vi.hoisted(() => ({
  group: null as unknown,
  attribution: vi.fn(),
  map: {
    getLayer: vi.fn(() => true),
    getSource: vi.fn(() => true),
    getZoom: () => 16,
    querySourceFeatures: vi.fn((): MapGeoJSONFeature[] => []),
    queryRenderedFeatures: vi.fn((): MapGeoJSONFeature[] => []),
    getStyle: vi.fn(
      (): { layers: { id: string; type: string; source?: string; "source-layer"?: string }[] } => ({
        layers: [],
      }),
    ),
    getFilter: vi.fn(() => undefined),
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
  useIntegrationAttribution: test.attribution,
  useIntegrationSourceAttributions: test.attribution,
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://fixture" }),
}));
vi.mock("@/lib/useExploreReachResults", () => {
  const result = { filtered: [] };
  return { useExploreReachResults: () => result };
});
vi.mock("next-intl", () => ({ useLocale: () => "de" }));

import type { Map as MapLibreMap } from "maplibre-gl";
import { getAmbientIdentity } from "@/components/map/ambientPlaceIdentity";
import { localizeTextField } from "@/components/map/localizeTextField";
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
  test.map.getStyle.mockReturnValue({ layers: [] });
  usePlaceStore.setState({ selectedPlace: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("ambient generation lifecycle", () => {
  it("keeps supplied ambient translations after production styledata localization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ manifest }) })),
    );
    render(<AmbientPlacesLayer />);
    await waitFor(() => expect(test.group).not.toBeNull());
    const descriptor = test.group as {
      layers: { type: string; layout?: Record<string, unknown> }[];
    };
    let textField = descriptor.layers.find((layer) => layer.type === "symbol")?.layout?.[
      "text-field"
    ];
    for (const [locale, expected] of [
      ["en", "Cologne Cathedral"],
      ["de", "Dom zu Köln"],
      ["en", "Cologne Cathedral"],
    ]) {
      textField = localizeTextField(textField, locale);
      const expression = createExpression(
        textField,
        "layers.ambient-places-labels.layout.text-field",
        latest.layout_symbol["text-field"],
      );
      expect(expression.result).toBe("success");
      expect(
        String(
          expression.value.evaluate(
            { zoom: 16 },
            {
              type: "Point",
              properties: {
                name: "Kölner Dom",
                name_en: "Cologne Cathedral",
                name_de: "Dom zu Köln",
              },
              geometry: [],
            },
          ),
        ),
      ).toBe(expected);
      expect(
        String(
          expression.value.evaluate(
            { zoom: 16 },
            { type: "Point", properties: { name: "Source name" }, geometry: [] },
          ),
        ),
      ).toBe("Source name");
    }
  });
  it.each(["category marker", "DOM pin"])(
    "keeps an overlapping %s selection instead of choosing a different ambient point",
    async (owner) => {
      const ambient = {
        type: "Feature",
        layer: { id: "ambient-places-points" },
        geometry: { type: "Point", coordinates: [6.08, 50.77] },
        properties: {
          id: "osm:node/1",
          name: "Ambient A",
          category: "cafe",
          rank: 2000,
          min_zoom: 15,
          tenant: false,
          sources: "osm",
        },
      } as MapGeoJSONFeature;
      const category = {
        ...ambient,
        layer: { id: "category-results-layer" },
        properties: { id: "osm:node/2", name: "Category B" },
      } as MapGeoJSONFeature;
      test.map.querySourceFeatures.mockReturnValue([ambient]);
      test.map.queryRenderedFeatures.mockImplementation((...args: unknown[]) => {
        const options = args[1] as { layers?: string[] } | undefined;
        return (owner === "category marker" ? [category, ambient] : [ambient]).filter((feature) =>
          options?.layers?.includes(feature.layer.id),
        );
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => ({ manifest }) })),
      );
      render(<AmbientPlacesLayer />);
      await waitFor(() => expect(test.group).not.toBeNull());
      const selected = {
        primaryScheme: "osm",
        ids: { osm: "node/2" },
        id: "osm:node/2",
        name: "Category B",
        address: "",
        coordinates: [6.08, 50.77],
      } as const;
      usePlaceStore.setState({
        selectedPlace: { ...selected, coordinates: [...selected.coordinates] },
      });
      const click = test.map.on.mock.calls.find(([event]) => event === "click")?.[1];
      const pin = document.createElement("div");
      pin.dataset.openmapxPinMarker = "true";
      act(() =>
        click?.({
          point: { x: 1, y: 2 },
          ...(owner === "DOM pin" ? { originalEvent: { target: pin } } : {}),
        }),
      );
      expect(usePlaceStore.getState().selectedPlace?.id).toBe("osm:node/2");
    },
  );
  it("uses a bounded generation source and cleans handlers/identity on disable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ manifest }) })),
    );
    const view = render(<AmbientPlacesLayer />);
    await waitFor(() => expect(test.group).not.toBeNull());
    expect(JSON.stringify(test.group)).toContain(manifest.generation);
    expect(JSON.stringify(test.group)).toContain('"maxzoom":18');
    const descriptor = test.group as {
      layers: { type: string; layout?: Record<string, unknown> }[];
    };
    const expression = createExpression(
      descriptor.layers.find((layer) => layer.type === "symbol")?.layout?.[
        "text-variable-anchor-offset"
      ],
      "layers.ambient-places-labels.layout.text-variable-anchor-offset",
      latest.layout_symbol["text-variable-anchor-offset"],
    );
    expect(expression.result, JSON.stringify(expression.value)).toBe("success");
    if (expression.result !== "success") throw new Error("Invalid placement policy");
    const positions = (rank: number) =>
      (
        expression.value.evaluate(
          { zoom: 16 },
          { type: "Point", properties: { rank }, geometry: [] },
        ) as { values: unknown[] }
      ).values;
    // The dense-city placement budget is six candidates for landmarks.
    expect(positions(2559)).toHaveLength(12);
    expect(positions(2059)).toHaveLength(2);
    expect(positions(3059)).toHaveLength(2);
    expect(test.attribution).toHaveBeenLastCalledWith("overlay-ambient-places", [
      "osm-ambient-places",
    ]);
    act(() => useAmbientPlacesStore.setState({ layerVisible: false }));
    await waitFor(() => expect(test.group).toBeNull());
    view.unmount();
    expect(test.map.off).toHaveBeenCalled();
  });
  it("keeps supported contributor credits for a combined publication and clears them on hide", async () => {
    const combined = {
      ...manifest,
      sources: {
        ...manifest.sources,
        overture: {
          region: "Germany",
          release: "2026-09-23.1",
          publishedAt: new Date().toISOString(),
          count: 1,
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ manifest: combined }) })),
    );
    render(<AmbientPlacesLayer />);
    await waitFor(() => expect(test.group).not.toBeNull());
    const sources = test.attribution.mock.lastCall?.[1] as string[];
    expect(sources).toEqual(
      expect.arrayContaining(["osm-ambient-places", "overture", "foursquare"]),
    );
    act(() => useAmbientPlacesStore.setState({ layerVisible: false }));
    expect(test.attribution).toHaveBeenLastCalledWith("overlay-ambient-places", []);
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
    test.map.queryRenderedFeatures.mockImplementation((...args: unknown[]) => {
      const options = args[1] as { layers?: string[] } | undefined;
      return options?.layers?.includes("ambient-places-points") ? [feature] : [];
    });
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
  it("shares a real worship identity with a religion-subclass basemap tap and hides its ambient copy", async () => {
    const place = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [6.6933392733335495, 51.19904645716551] },
      properties: {
        id: "osm:way/28562993",
        name: "Quirinus-Münster",
        category: "place_of_worship",
        rank: 2559,
        min_zoom: 14,
        tenant: false,
        sources: "osm",
      },
    } as MapGeoJSONFeature;
    const base = {
      id: 285629932,
      source: "openmaptiles",
      sourceLayer: "poi",
      layer: { id: "poi-level-3" },
      geometry: { type: "Point", coordinates: [6.693227291107178, 51.19902166658045] },
      properties: { name: "Quirinus-Münster", class: "place_of_worship", subclass: "christian" },
    } as MapGeoJSONFeature;
    test.map.getStyle.mockReturnValue({
      layers: [
        { id: "poi-level-3", type: "symbol", source: "openmaptiles", "source-layer": "poi" },
      ],
    });
    test.map.querySourceFeatures.mockReturnValue([place]);
    test.map.queryRenderedFeatures.mockReturnValue([base]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ manifest }) })),
    );
    render(<AmbientPlacesLayer />);
    await waitFor(() => expect(test.group).not.toBeNull());
    expect(getAmbientIdentity(test.map as unknown as MapLibreMap, base)?.id).toBe(
      place.properties.id,
    );
    expect(JSON.stringify(test.map.setFilter.mock.calls.at(-1))).toContain(place.properties.id);
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
