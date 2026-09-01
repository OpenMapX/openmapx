import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import manifest from "../manifest.json";
import { useAirportsOverlayStore } from "../store";

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

import { AirportsOverlay } from "../map-layer";

const CIRCLE_LAYER_ID = "openmapx-airports-circles";
const MIN_ZOOM = manifest.frontend.overlay.minZoom;

const registry = new IntegrationRegistry([
  {
    id: "overlay-ourairports",
    name: "Airports",
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

const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({ type: "FeatureCollection", features: [] }),
}));

beforeEach(() => {
  fake = createFakeMap();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  useAirportsOverlayStore.setState({ layerVisible: true });
});

afterEach(() => {
  useAirportsOverlayStore.setState({ layerVisible: false });
  vi.unstubAllGlobals();
});

describe("AirportsOverlay zoom gate", () => {
  it("fetches viewport airports at or above the manifest minZoom", () => {
    render(<AirportsOverlay />, { wrapper });

    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/integrations/overlay-ourairports/airports",
    );
  });

  it("registers the circle layer in the overlay-points slot", () => {
    render(<AirportsOverlay />, { wrapper });

    expect(layerRegistrations()).toContainEqual({
      id: CIRCLE_LAYER_ID,
      slot: "overlay-points",
      order: 6,
    });
  });

  it("skips fetching below minZoom but keeps the layer clamped to it", () => {
    fake = createFakeMap({ zoom: MIN_ZOOM - 1 });
    render(<AirportsOverlay />, { wrapper });

    act(() => {
      fake.emit("moveend");
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.state.layers.get(CIRCLE_LAYER_ID)?.minzoom).toBe(MIN_ZOOM);
  });

  it("resumes fetching once the user zooms back across the threshold", () => {
    fake = createFakeMap({ zoom: MIN_ZOOM - 1 });
    render(<AirportsOverlay />, { wrapper });
    expect(fetchMock).not.toHaveBeenCalled();

    fake.state.zoom = MIN_ZOOM;
    act(() => {
      fake.emit("moveend");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
