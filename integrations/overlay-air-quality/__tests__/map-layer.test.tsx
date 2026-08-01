import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/components/map/layers/layerStack";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import manifest from "../manifest.json";
import { useAirQualityStore } from "../store";

let fake: FakeMap;

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
  }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

vi.mock("maplibre-gl", () => ({
  default: {
    Popup: class FakePopup {
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
        return this;
      }
    },
  },
}));

import { AirQualityLayer } from "../map-layer";

const AQ_LAYER_ID = "air-quality-layer";
const MIN_ZOOM = manifest.frontend.overlay.minZoom;

const registry = new IntegrationRegistry([
  {
    id: "overlay-air-quality",
    name: "Air quality",
    enabled: true,
    domains: ["map-overlay"],
    isBuiltIn: true,
    frontend: { overlay: { minZoom: MIN_ZOOM } },
  },
]);

const wrapper = ({ children }: { children: ReactNode }) => (
  <IntegrationRegistryContext.Provider value={registry}>
    {children}
  </IntegrationRegistryContext.Provider>
);

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));

beforeEach(() => {
  fake = createFakeMap();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  useAirQualityStore.setState({ layerVisible: true });
});

afterEach(() => {
  useAirQualityStore.setState({ layerVisible: false });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AirQualityLayer zoom gate", () => {
  it("fetches viewport stations at or above the manifest minZoom", () => {
    render(<AirQualityLayer />, { wrapper });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/integrations/overlay-air-quality/air-quality/stations",
    );
  });

  it("registers the circle layer in the overlay-points slot", () => {
    render(<AirQualityLayer />, { wrapper });

    expect(layerRegistrations()).toContainEqual({
      id: AQ_LAYER_ID,
      slot: "overlay-points",
      order: 0,
    });
  });

  it("skips fetching below minZoom but keeps the layer clamped to it", () => {
    vi.useFakeTimers();
    fake = createFakeMap({ zoom: MIN_ZOOM - 1 });
    render(<AirQualityLayer />, { wrapper });

    // Neither the initial sync nor a pan below the threshold may fetch.
    act(() => {
      fake.emit("moveend");
      vi.advanceTimersByTime(1000);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // The layer itself carries the manifest threshold, so any stale features
    // are hidden by MapLibre instead of painting under a world view.
    expect(fake.state.layers.get(AQ_LAYER_ID)?.minzoom).toBe(MIN_ZOOM);
  });

  it("resumes fetching once the user zooms back across the threshold", () => {
    vi.useFakeTimers();
    fake = createFakeMap({ zoom: MIN_ZOOM - 1 });
    render(<AirQualityLayer />, { wrapper });
    expect(fetchMock).not.toHaveBeenCalled();

    fake.state.zoom = MIN_ZOOM;
    act(() => {
      fake.emit("moveend");
      vi.advanceTimersByTime(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
