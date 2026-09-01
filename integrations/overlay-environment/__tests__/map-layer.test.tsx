import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import manifest from "../manifest.json";
import { useEnvironmentStore } from "../store";

let fake: FakeMap;

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
  }),
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

vi.mock("maplibre-gl", () => ({
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
}));

import { EnvironmentLayer } from "../map-layer";

const ENV_LAYER_ID = "env-circle-layer";
const MIN_ZOOM = manifest.frontend.overlay.minZoom;

const registry = new IntegrationRegistry([
  {
    id: "overlay-environment",
    name: "Environment",
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
  useEnvironmentStore.setState({ layerVisible: true });
});

afterEach(() => {
  useEnvironmentStore.setState({ layerVisible: false });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("EnvironmentLayer zoom gate", () => {
  it("fetches viewport stations at or above the manifest minZoom", () => {
    render(<EnvironmentLayer />, { wrapper });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/integrations/overlay-environment/stations",
    );
  });

  it("registers the circle layer in the overlay-points slot", () => {
    render(<EnvironmentLayer />, { wrapper });

    expect(layerRegistrations()).toContainEqual({
      id: ENV_LAYER_ID,
      slot: "overlay-points",
      order: 1,
    });
  });

  it("skips fetching below minZoom but keeps the layer clamped to it", () => {
    vi.useFakeTimers();
    fake = createFakeMap({ zoom: MIN_ZOOM - 1 });
    render(<EnvironmentLayer />, { wrapper });

    act(() => {
      fake.emit("moveend");
      vi.advanceTimersByTime(1000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.state.layers.get(ENV_LAYER_ID)?.minzoom).toBe(MIN_ZOOM);
  });

  it("resumes fetching once the user zooms back across the threshold", () => {
    vi.useFakeTimers();
    fake = createFakeMap({ zoom: MIN_ZOOM - 1 });
    render(<EnvironmentLayer />, { wrapper });
    expect(fetchMock).not.toHaveBeenCalled();

    fake.state.zoom = MIN_ZOOM;
    act(() => {
      fake.emit("moveend");
      vi.advanceTimersByTime(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
