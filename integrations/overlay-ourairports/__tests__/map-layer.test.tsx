import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import manifest from "../manifest.json";
import { useAirportsOverlayStore } from "../store";

let fake: FakeMap;
const mapRef = {
  get current() {
    return fake.map;
  },
};

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef,
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
    dataSources: manifest.dataSources,
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
  act(() => useAirportsOverlayStore.setState({ layerVisible: false }));
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

  it("fetches the viewport once when shown", () => {
    render(<AirportsOverlay />, { wrapper });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies a changed manifest minZoom to the installed layer", () => {
    const raised = new IntegrationRegistry([
      {
        id: "overlay-ourairports",
        name: "Airports",
        enabled: true,
        domains: ["map-overlay"],
        dataSources: manifest.dataSources,
        isBuiltIn: true,
        frontend: { overlay: { minZoom: MIN_ZOOM + 2 } },
      },
    ]);
    const view = render(
      <IntegrationRegistryContext.Provider value={registry}>
        <AirportsOverlay />
      </IntegrationRegistryContext.Provider>,
    );
    expect(fake.state.layers.get(CIRCLE_LAYER_ID)?.minzoom).toBe(MIN_ZOOM);

    view.rerender(
      <IntegrationRegistryContext.Provider value={raised}>
        <AirportsOverlay />
      </IntegrationRegistryContext.Provider>,
    );
    expect(fake.state.layers.get(CIRCLE_LAYER_ID)?.minzoom).toBe(MIN_ZOOM + 2);
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

import type { MapGeoJSONFeature } from "maplibre-gl";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";

it("credits actual airport markers/labels and clears below minzoom or outside viewport", async () => {
  vi.useFakeTimers();
  const fixture = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { rank: 0, name: "Airport", ident: "A" },
      },
    ],
  };
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => fixture }));
  useMapAttributionStore.setState({ byLayer: {} });
  render(<AirportsOverlay />, { wrapper });
  await act(async () => {});
  const data = fake.state.sources.get("openmapx-airports-source")
    ?.data as GeoJSON.FeatureCollection;
  fake.setRenderedFeatures(CIRCLE_LAYER_ID, data.features as MapGeoJSONFeature[]);
  const flush = () =>
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
  const html = () =>
    Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((entry) => entry.fullHtml)
      .join(" ");
  flush();
  expect(html()).toContain("OurAirports");
  fake.state.zoom = MIN_ZOOM - 1;
  flush();
  expect(html()).toBe("");
  fake.state.zoom = MIN_ZOOM;
  fake.setRenderedFeatures(CIRCLE_LAYER_ID, []);
  flush();
  expect(html()).toBe("");
  vi.useRealTimers();
});
