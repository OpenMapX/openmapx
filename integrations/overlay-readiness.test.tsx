import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, createQueryWrapper, type FakeMap, render } from "@/test";

let fake: FakeMap;
const mapRef = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useOptionalEnv: () => ({ apiUrl: "https://api.test" }),

  useEnv: () => ({ apiUrl: "https://api.test" }),
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/map/useDrawnDirectionsRoutes", () => ({
  useDrawnDirectionsRoutes: () => ({
    routes: [],
    activeRouteIndex: 0,
    mode: "driving",
    evStops: [],
    navigating: false,
  }),
}));

import { EarthquakeLayer } from "./overlay-earthquakes/map-layer";
import { useEarthquakeStore } from "./overlay-earthquakes/store";
import { EnvironmentLayer } from "./overlay-environment/map-layer";
import { useEnvironmentStore } from "./overlay-environment/store";
import { LiveTransitLayer } from "./overlay-live-transit/map-layer";
import { useLiveTransitStore } from "./overlay-live-transit/store";
import { NaturalEventLayer } from "./overlay-natural-events/map-layer";
import { useNaturalEventStore } from "./overlay-natural-events/store";
import { NauticalLayer } from "./overlay-nautical/map-layer";
import { useNauticalStore } from "./overlay-nautical/store";
import { AirportsOverlay } from "./overlay-ourairports/map-layer";
import { useAirportsOverlayStore } from "./overlay-ourairports/store";
import SunTimeLayer from "./overlay-sun-time/map-layer";
import { useSunTimeStore } from "./overlay-sun-time/store";
import { MeasurementLayer } from "./overlay-tool-measurement/map-layer";
import { useMeasurementStore } from "./overlay-tool-measurement/store";
import { TravelTimeLayer } from "./overlay-tool-travel-time/map-layer";
import { useTravelTimeStore } from "./overlay-tool-travel-time/store";
import { TransitLayer } from "./overlay-transit/map-layer";
import { useTransitStore } from "./overlay-transit/store";
import { WeatherLayer } from "./overlay-weather/map-layer";
import { useWeatherStore } from "./overlay-weather/store";
import { WeatherAlertLayer } from "./overlay-weather-alerts/map-layer";
import { useWeatherAlertStore } from "./overlay-weather-alerts/store";
import { RoadConditionsLayer } from "./road-conditions/map-layer";
import { useRoadConditionsStore } from "./road-conditions/store";

const cases: { name: string; Component: ComponentType; layer: string; activate: () => void }[] = [
  {
    name: "environment",
    Component: EnvironmentLayer,
    layer: "env-circle-layer",
    activate: () => useEnvironmentStore.setState({ layerVisible: true }),
  },
  {
    name: "natural events",
    Component: NaturalEventLayer,
    layer: "openmapx-natural-events-circles",
    activate: () => useNaturalEventStore.setState({ layerVisible: true }),
  },
  {
    name: "weather alerts",
    Component: WeatherAlertLayer,
    layer: "openmapx-weather-alerts-fill",
    activate: () => useWeatherAlertStore.setState({ layerVisible: true }),
  },
  {
    name: "nautical",
    Component: NauticalLayer,
    layer: "openmapx-nautical-seamark-layer",
    activate: () =>
      useNauticalStore.setState({ panelOpen: true, layerVisible: true, showSeamarks: true }),
  },
  {
    name: "transit",
    Component: TransitLayer,
    layer: "openmapx-transit-motis-line",
    activate: () => useTransitStore.setState({ panelOpen: true, layerVisible: true }),
  },
  {
    name: "weather",
    Component: WeatherLayer,
    layer: "weather-owm-layer",
    activate: () =>
      useWeatherStore.setState({
        layerVisible: true,
        activeSubLayer: "temperature",
        owmAvailable: true,
      }),
  },
  {
    name: "live transit",
    Component: LiveTransitLayer,
    layer: "live-transit-icon",
    activate: () => useLiveTransitStore.setState({ layerVisible: true }),
  },
  {
    name: "measurement",
    Component: MeasurementLayer,
    layer: "measurement-line",
    activate: () => useMeasurementStore.setState({ isActive: true }),
  },
  {
    name: "travel time",
    Component: TravelTimeLayer,
    layer: "travel-time-fill",
    activate: () => useTravelTimeStore.setState({ isActive: true, mode: "walking", origin: null }),
  },
  {
    name: "road conditions",
    Component: RoadConditionsLayer,
    layer: "omx-road-conditions-markers",
    activate: () => useRoadConditionsStore.setState({ panelOpen: true, layerVisible: true }),
  },
  {
    name: "sun time",
    Component: SunTimeLayer,
    layer: "sun-time-band-0",
    activate: () => useSunTimeStore.setState({ layerVisible: true, showTerminator: true }),
  },
  {
    name: "earthquakes",
    Component: EarthquakeLayer,
    layer: "openmapx-earthquakes-circles",
    activate: () => useEarthquakeStore.setState({ layerVisible: true }),
  },
  {
    name: "airports",
    Component: AirportsOverlay,
    layer: "openmapx-airports-circles",
    activate: () => useAirportsOverlayStore.setState({ layerVisible: true }),
  },
];

function createPendingMap() {
  const pending = createFakeMap({ styleLoaded: false });
  Object.assign(pending.map, { doubleClickZoom: { enable: vi.fn(), disable: vi.fn() } });
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = createPendingMap();
  // External acquisition stays pending: layer installation must not depend on it.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(cases)("$name style readiness", ({ Component, layer, activate }) => {
  it("installs a parsed style layer while unrelated sources remain pending without idle", () => {
    activate();
    const view = render(<Component />, { wrapper: createQueryWrapper() });
    expect(fake.map.isStyleLoaded()).toBe(false);
    expect(fake.map.getLayer(layer)).toBeDefined();
    view.unmount();
  });

  it("installs once the stylesheet finishes parsing, without idle", () => {
    activate();
    const style = fake.map.getStyle();
    let parsed = false;
    vi.spyOn(fake.map, "getStyle").mockImplementation(() =>
      parsed ? style : (undefined as never),
    );
    const addSource = fake.map.addSource.bind(fake.map);
    vi.spyOn(fake.map, "addSource").mockImplementation((...args) => {
      if (!parsed) throw new Error("Style is not done loading");
      return addSource(...args);
    });
    const view = render(<Component />, { wrapper: createQueryWrapper() });
    expect(fake.map.getLayer(layer)).toBeUndefined();
    parsed = true;
    act(() => {
      fake.emit("styledata");
      fake.emit("style.load");
    });
    expect(fake.map.getLayer(layer)).toBeDefined();
    view.unmount();
  });

  it("cancels a pending install on unmount", () => {
    activate();
    let parsed = false;
    fake = createPendingMap();
    const nextStyle = fake.map.getStyle();
    vi.spyOn(fake.map, "getStyle").mockImplementation(() =>
      parsed ? nextStyle : (undefined as never),
    );
    const nextAddSource = fake.map.addSource.bind(fake.map);
    vi.spyOn(fake.map, "addSource").mockImplementation((...args) => {
      if (!parsed) throw new Error("Style is not done loading");
      return nextAddSource(...args);
    });
    const pending = render(<Component />, { wrapper: createQueryWrapper() });
    pending.unmount();
    parsed = true;
    fake.state.styleLoaded = true;
    act(() => {
      fake.emit("idle");
      fake.emit("styledata");
      fake.emit("render");
    });
    expect(fake.map.getLayer(layer)).toBeUndefined();
  });
});
