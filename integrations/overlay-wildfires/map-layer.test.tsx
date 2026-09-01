import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render, waitFor } from "@/test";
import { useWildfireStore } from "./store";

const popupState = vi.hoisted(() => ({
  instances: [] as Array<{ removeCalls: number }>,
}));
const attributionState = vi.hoisted(() => ({
  filtered: vi.fn(),
}));
const mapContext = vi.hoisted(() => ({ mapRef: { current: null as FakeMap["map"] | null } }));

let fake: FakeMap;

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: mapContext.mapRef,
    mapReady: true,
    styleVersion: 0,
  }),
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

vi.mock("@/integration-api/overlay/useIntegrationAttribution", () => ({
  useIntegrationAttribution: vi.fn(),
  useIntegrationSourceAttributions: attributionState.filtered,
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en-GB",
  useTranslations: () => (key: string) => key,
}));

vi.mock("maplibre-gl", () => ({
  Popup: class {
    removeCalls = 0;

    constructor() {
      popupState.instances.push(this);
    }

    setLngLat() {
      return this;
    }

    setHTML() {
      return this;
    }

    addTo() {
      return this;
    }

    remove() {
      this.removeCalls += 1;
      return this;
    }
  },
}));

import { WildfireLayer } from "./map-layer";

const SOURCE_ID = "openmapx-wildfires-source";
const CIRCLE_LAYER_ID = "openmapx-wildfires-circles";
const POLYGON_GEOMETRY = {
  type: "Polygon",
  coordinates: [
    [
      [8, 50],
      [9, 50],
      [9, 51],
      [8, 50],
    ],
  ],
};

function providerFeature(source: "nifc" | "effis") {
  const id = `${source}:1`;
  return {
    type: "Feature",
    id,
    properties:
      source === "nifc"
        ? {
            id,
            kind: "reported-perimeter",
            provider: source,
            coverage: "United States",
            name: "Pine Fire",
          }
        : {
            id,
            kind: "satellite-burned-area",
            provider: source,
            areaHectares: 42,
          },
    geometry: POLYGON_GEOMETRY,
  };
}

const HOTSPOT_FEATURE = {
  type: "Feature",
  properties: {
    latitude: 50,
    longitude: 8,
    frp: 12,
    brightness: 301,
    confidence: "high",
    satellite: "VIIRS",
    ageMs: 60_000,
    dayNight: "D",
    acqDate: "2026-08-12",
    acqTime: "1234",
    source: "VIIRS_SNPP_NRT",
  },
  geometry: { type: "Point", coordinates: [8, 50] },
} as unknown as MapGeoJSONFeature;

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true });
  mapContext.mapRef.current = fake.map;
  popupState.instances.length = 0;
  useWildfireStore.setState({
    layerVisible: true,
    showHotspots: false,
    showNifcPerimeters: false,
    showEffisBurnedAreas: false,
    showNoaaSmoke: false,
    showHeatmap: false,
    loading: false,
    lastUpdated: null,
    dayRange: 1,
    source: "VIIRS_SNPP_NRT",
  });
  attributionState.filtered.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WildfireLayer hotspot composition", () => {
  it("composes both polygon sources and credits only the enabled wildfire providers", async () => {
    useWildfireStore.setState({ showNifcPerimeters: true, showEffisBurnedAreas: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => {
          const source = url.includes("perimeters/nifc") ? "nifc" : "effis";
          return {
            type: "FeatureCollection",
            features: [providerFeature(source)],
            source,
            fetchedAt: "2026-08-12T12:00:00.000Z",
            stale: false,
            truncated: false,
          };
        },
      })),
    );

    render(<WildfireLayer />);

    await waitFor(() =>
      expect(fake.state.sources.has("openmapx-wildfires-nifc-source")).toBe(true),
    );
    await waitFor(() =>
      expect(fake.state.sources.has("openmapx-wildfires-effis-source")).toBe(true),
    );
    await waitFor(() => {
      expect(attributionState.filtered).toHaveBeenLastCalledWith("overlay-wildfires", [
        "nifc-wfigs",
        "effis",
      ]);
    });
    expect(
      attributionState.filtered.mock.calls.some(([, sourceIds]) =>
        (sourceIds as string[]).includes("noaa-hms"),
      ),
    ).toBe(false);
  });

  it("keeps FIRMS inactive until showHotspots turns on, then removes it when turned off", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ type: "FeatureCollection", features: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WildfireLayer />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);

    act(() => {
      useWildfireStore.getState().setShowHotspots(true);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fake.state.layers.get(CIRCLE_LAYER_ID)?.type).toBe("circle");

    act(() => {
      useWildfireStore.getState().setShowHotspots(false);
    });
    await waitFor(() => expect(fake.state.sources.has(SOURCE_ID)).toBe(false));
    expect(fake.state.layers.has(CIRCLE_LAYER_ID)).toBe(false);
  });

  it("owns one popup at a time and clears the closed popup before another activation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ type: "FeatureCollection", features: [] }),
      })),
    );
    useWildfireStore.setState({ showHotspots: true });
    render(<WildfireLayer />);
    await waitFor(() => expect(fake.state.layers.has(CIRCLE_LAYER_ID)).toBe(true));

    act(() => {
      fake.emit("click", { features: [HOTSPOT_FEATURE] });
      fake.emit("click", { features: [HOTSPOT_FEATURE] });
    });
    expect(popupState.instances).toHaveLength(2);
    expect(popupState.instances[0]?.removeCalls).toBe(1);
    expect(popupState.instances[1]?.removeCalls).toBe(0);

    act(() => {
      useWildfireStore.getState().setShowHotspots(false);
    });
    await waitFor(() => expect(popupState.instances[1]?.removeCalls).toBe(1));

    act(() => {
      useWildfireStore.getState().setShowHotspots(true);
    });
    await waitFor(() => expect(fake.state.layers.has(CIRCLE_LAYER_ID)).toBe(true));
    act(() => {
      fake.emit("click", { features: [HOTSPOT_FEATURE] });
    });

    expect(popupState.instances).toHaveLength(3);
    expect(popupState.instances[1]?.removeCalls).toBe(1);
    expect(popupState.instances[2]?.removeCalls).toBe(0);
  });

  it("removes the current FIRMS popup exactly once when the whole coordinator unmounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ type: "FeatureCollection", features: [] }),
      })),
    );
    useWildfireStore.setState({ showHotspots: true });
    const { unmount } = render(<WildfireLayer />);
    await waitFor(() => expect(fake.state.layers.has(CIRCLE_LAYER_ID)).toBe(true));

    act(() => fake.emit("click", { features: [HOTSPOT_FEATURE] }));
    expect(popupState.instances).toHaveLength(1);

    unmount();
    expect(popupState.instances[0]?.removeCalls).toBe(1);
  });
});
