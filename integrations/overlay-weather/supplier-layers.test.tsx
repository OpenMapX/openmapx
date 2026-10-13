import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import hikingManifest from "../overlay-hiking/manifest.json";
import { useHikingStore } from "../overlay-hiking/store";
import nauticalManifest from "../overlay-nautical/manifest.json";
import { useNauticalStore } from "../overlay-nautical/store";
import trafficManifest from "../overlay-traffic-tomtom/manifest.json";
import { useTrafficStore } from "../overlay-traffic-tomtom/store";
import weatherManifest from "./manifest.json";
import { useWeatherStore } from "./store";

let fake: FakeMap;
const MAP_REF = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: MAP_REF, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({
    apiUrl: "https://api.test",
    trafficTileUrlTemplate: "https://api.test/traffic/{z}/{x}/{y}.png",
  }),
}));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { HikingTrailsLayer } from "../overlay-hiking/map-layer";
import { MountainShelterLayer } from "../overlay-hiking/shelter-layer";
import { NauticalLayer } from "../overlay-nautical/map-layer";
import { TrafficLayer } from "../overlay-traffic-tomtom/map-layer";
import { WeatherLayer } from "./map-layer";

const registry = new IntegrationRegistry(
  [weatherManifest, nauticalManifest, hikingManifest, trafficManifest].map((m) => ({
    ...m,
    name: m.id,
    enabled: true,
    isBuiltIn: true,
  })) as never,
);
const wrapper = ({ children }: { children: ReactNode }) => (
  <IntegrationRegistryContext.Provider value={registry}>
    {children}
  </IntegrationRegistryContext.Provider>
);
let loaded: Set<string>;
function bridge() {
  const tiles = new WeakMap<object, { hasData(): boolean; texture: object; fadeOpacity: number }>();
  function tileFor(id: string) {
    const source = fake.map.getSource(id);
    if (!source) return undefined;
    let tile = tiles.get(source);
    if (!tile) {
      tile = { hasData: () => loaded.has(id), texture: {}, fadeOpacity: 1 };
      tiles.set(source, tile);
    }
    return tile;
  }
  Object.defineProperty(fake.map, "style", {
    configurable: true,
    value: {
      getLayer: (id: string) => {
        const l = fake.state.layers.get(id);
        return l
          ? { type: l.type, paint: { get: (name: string) => l.paint?.[name] ?? 1 } }
          : undefined;
      },
      tileManagers: new Proxy(
        {},
        {
          get: (_t, id: string) => ({
            getVisibleCoordinates: () => [{ key: id }],
            getTile: () => tileFor(id),
          }),
        },
      ),
    },
  });
}
function flush() {
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
}
function html() {
  return Object.values(useMapAttributionStore.getState().byLayer).flat().join(" ");
}
beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap();
  loaded = new Set();
  bridge();
  useMapAttributionStore.setState({ byLayer: {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("weather credits effective radar, excluding unavailable OWM and transparent preload frames", () => {
  useWeatherStore.setState({
    layerVisible: true,
    activeSubLayer: "temperature",
    owmAvailable: false,
    radarHost: "https://tilecache.rainviewer.com",
    radarPastFrames: [
      { time: 1, path: "/1" },
      { time: 2, path: "/2" },
    ],
    radarNowcastFrames: [],
    radarFrameIndex: 0,
  });
  render(<WeatherLayer />, { wrapper });
  loaded.add("weather-radar-1");
  flush();
  expect(html()).toBe("");
  loaded.add("weather-radar-0");
  flush();
  expect(html()).toContain("RainViewer");
  expect(html()).not.toContain("OpenWeather");
  act(() => useWeatherStore.setState({ owmAvailable: true }));
  loaded.add("weather-owm-source");
  flush();
  expect(html()).toContain("OpenWeather");
  expect(html()).not.toContain("RainViewer");
});
it("TomTom credits no failed first tile or low zoom, but retains successful cached content", () => {
  useTrafficStore.setState({ panelOpen: true, layerVisible: true });
  render(<TrafficLayer />, { wrapper });
  flush();
  expect(html()).toBe("");
  loaded.add("openmapx-traffic-source");
  flush();
  expect(html()).toContain("TomTom");
  fake.state.zoom = 9;
  flush();
  expect(html()).toBe("");
  fake.state.zoom = 12;
  fake.emit("error", { sourceId: "openmapx-traffic-source" });
  flush();
  expect(html()).toContain("TomTom");
});
it("hiking raster alone owes no Refuges.info credit", () => {
  useHikingStore.setState({ layerVisible: true });
  render(<HikingTrailsLayer />, { wrapper });
  loaded.add("openmapx-hiking-trails-source");
  flush();
  expect(html()).toContain("waymarkedtrails");
  expect(html()).not.toContain("Refuges.info");
});
it("nautical default tiles credit OpenSeaMap and its OSM data, excluding disabled charts and gauges", () => {
  useNauticalStore.setState({
    panelOpen: true,
    layerVisible: true,
    showSeamarks: true,
    showDepth: false,
    showNoaaCharts: false,
    showHarbors: false,
    showTideStations: false,
  });
  render(<NauticalLayer />, { wrapper });
  loaded.add("openmapx-nautical-seamark-source");
  flush();
  expect(html()).toContain("OpenSeaMap");
  expect(html()).toContain("OpenStreetMap");
  expect(html()).not.toContain("GEBCO");
  expect(html()).not.toContain("CO-OPS");
});

it("nautical depth separates GEBCO relief from OpenSeaMap contours across zoom", () => {
  useNauticalStore.setState({
    panelOpen: true,
    layerVisible: true,
    showSeamarks: false,
    showDepth: true,
    showNoaaCharts: false,
    showHarbors: false,
    showTideStations: false,
  });
  fake.state.zoom = 7;
  render(<NauticalLayer />, { wrapper });
  loaded.add("openmapx-nautical-depth-relief-source");
  loaded.add("openmapx-nautical-depth-contour-source");
  flush();
  expect(html()).toContain("GEBCO");
  expect(html()).toContain("OpenSeaMap");
  expect(html()).not.toContain("OpenStreetMap");
  fake.state.zoom = 5;
  flush();
  expect(html()).toContain("GEBCO");
  expect(html()).not.toContain("OpenSeaMap");
});
it("nautical national chart credits follow the actual regional mounted raster", () => {
  let norway = false;
  fake.map.fire = ((event: string) => {
    fake.emit(event);
    return fake.map;
  }) as never;
  fake.map.getBounds = () =>
    ({
      getSouth: () => (norway ? 60 : 40),
      getNorth: () => (norway ? 62 : 43),
      getWest: () => (norway ? 5 : -73),
      getEast: () => (norway ? 8 : -70),
    }) as never;
  useNauticalStore.setState({
    panelOpen: true,
    layerVisible: true,
    showSeamarks: false,
    showDepth: false,
    showNoaaCharts: true,
    showHarbors: false,
    showTideStations: false,
  });
  render(<NauticalLayer />, { wrapper });
  loaded.add("openmapx-nautical-noaa-source");
  loaded.add("openmapx-nautical-kartverket-source");
  flush();
  expect(html()).toContain("NOAA Office of Coast Survey");
  expect(html()).not.toContain("Kartverket");
  norway = true;
  act(() => fake.emit("moveend"));
  flush();
  expect(html()).toContain("Kartverket");
  expect(html()).not.toContain("NOAA");
});
it("shelter credit follows actual rendered viewport markers and minimum zoom", () => {
  useHikingStore.setState({ layerVisible: true });
  render(<MountainShelterLayer />, { wrapper });
  const feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [6, 51] },
    properties: { _mapAttributions: '[{"sourceId":"refuges-info","name":"Refuges.info"}]' },
  };
  fake.setRenderedFeatures("openmapx-shelters-circles", [feature] as never);
  flush();
  expect(html()).toContain("Refuges.info");
  fake.state.zoom = 9;
  flush();
  expect(html()).toBe("");
  fake.state.zoom = 10;
  flush();
  expect(html()).toContain("Refuges.info");
  fake.setRenderedFeatures("openmapx-shelters-circles", []);
  flush();
  expect(html()).toBe("");
});
it("weather legend displays captured current and reverse-name receipts independently of the raster supplier", async () => {
  const { WeatherLegend } = await import("./legend");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        String(url).includes("/weather/current")
          ? {
              current: {
                weatherCode: 0,
                isDay: true,
                temperature: 20,
                feelsLike: 20,
                windSpeed: 10,
                humidity: 50,
                pressure: 1000,
                cloudCover: 0,
              },
              source: "unknown",
              contributors: [{ sourceId: "current", name: "Current supplier" }],
            }
          : String(url).includes("/geocode/reverse")
            ? { city: "City", contributors: [{ sourceId: "reverse", name: "Reverse supplier" }] }
            : String(url).includes("/config")
              ? { temperature: false }
              : { host: "https://tilecache.rainviewer.com", past: [], nowcast: [] },
    })),
  );
  useWeatherStore.setState({
    panelOpen: true,
    layerVisible: true,
    activeSubLayer: "radar",
    currentWeather: null,
    locationName: "",
    currentWeatherContributors: [],
    locationNameContributors: [],
  });
  const { getByRole } = render(
    <>
      <WeatherLayer />
      <WeatherLegend />
    </>,
    { wrapper },
  );
  await act(async () => {
    vi.advanceTimersByTime(1600);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(getByRole("link", { name: "Current supplier" })).toBeVisible();
  expect(getByRole("link", { name: "Reverse supplier" })).toBeVisible();
  expect(html()).toBe("");
});

it("weather removes obsolete mounted frames when a refreshed catalog shrinks", () => {
  useWeatherStore.setState({
    layerVisible: true,
    activeSubLayer: "radar",
    radarHost: "https://radar.test",
    radarPastFrames: Array.from({ length: 12 }, (_, i) => ({ time: i, path: `/${i}` })),
    radarNowcastFrames: [],
    radarFrameIndex: 10,
    radarPlaying: false,
  });
  render(<WeatherLayer />, { wrapper });
  loaded.add("weather-radar-10");
  flush();
  expect(fake.map.getLayer("weather-radar-layer-10")).toBeDefined();
  act(() =>
    useWeatherStore.getState().setRadarMeta(
      "https://radar.test",
      Array.from({ length: 6 }, (_, i) => ({ time: 20 + i, path: `/new/${i}` })),
      [],
    ),
  );
  flush();
  expect(fake.map.getLayer("weather-radar-layer-10")).toBeUndefined();
  expect(fake.map.getSource("weather-radar-10")).toBeUndefined();
});

it.each([
  ["weather", "rainviewer", "weather-radar-0", WeatherLayer],
  ["hiking", "waymarked-trails", "openmapx-hiking-trails-source", HikingTrailsLayer],
  ["traffic", "tomtom", "openmapx-traffic-source", TrafficLayer],
  ["nautical", "openseamap", "openmapx-nautical-seamark-source", NauticalLayer],
] as const)(
  "%s retains the notice of the exact mounted tile after registry metadata refresh",
  (_name, sourceId, tileSource, Component) => {
    useWeatherStore.setState({
      layerVisible: true,
      activeSubLayer: "radar",
      radarHost: "https://radar.test",
      radarPastFrames: [{ time: 1, path: "/1" }],
      radarNowcastFrames: [],
      radarFrameIndex: 0,
    });
    useHikingStore.setState({ layerVisible: true });
    useTrafficStore.setState({ panelOpen: true, layerVisible: true });
    useNauticalStore.setState({
      panelOpen: true,
      layerVisible: true,
      showSeamarks: true,
      showDepth: false,
      showNoaaCharts: false,
      showHarbors: false,
      showTideStations: false,
    });
    const metadata = registry.findDataSource(sourceId);
    if (!metadata) throw new Error(sourceId);
    const original = metadata.attribution;
    metadata.attribution = "ORIGINAL NOTICE";
    try {
      const view = render(<Component />, { wrapper });
      loaded.add(tileSource);
      flush();
      expect(html()).toContain("ORIGINAL NOTICE");
      metadata.attribution = "REPLACEMENT NOTICE";
      view.rerender(<Component />);
      flush();
      expect(html()).toContain("ORIGINAL NOTICE");
      expect(html()).not.toContain("REPLACEMENT NOTICE");
    } finally {
      metadata.attribution = original;
    }
  },
);

it.each(["radar", "disabled", "unmounted", "map-replaced"] as const)(
  "weather cancels an obsolete pending OWM mount when %s",
  (change) => {
    useWeatherStore.setState({
      layerVisible: true,
      activeSubLayer: "temperature",
      owmAvailable: true,
      radarHost: "https://radar.test",
      radarPastFrames: [{ time: 1, path: "/1" }],
      radarNowcastFrames: [],
      radarFrameIndex: 0,
    });
    fake.state.styleLoaded = false;
    const oldMap = fake;
    const view = render(<WeatherLayer />, { wrapper });
    expect(oldMap.map.getLayer("weather-owm-layer")).toBeUndefined();
    if (change === "unmounted") view.unmount();
    else if (change === "map-replaced") {
      fake = createFakeMap();
      bridge();
      view.rerender(<WeatherLayer />);
    } else
      act(() =>
        useWeatherStore.setState(
          change === "radar" ? { activeSubLayer: "radar" } : { layerVisible: false },
        ),
      );
    oldMap.state.styleLoaded = true;
    act(() => oldMap.emit("idle"));
    expect(oldMap.map.getLayer("weather-owm-layer")).toBeUndefined();
    expect(oldMap.map.getSource("weather-owm-source")).toBeUndefined();
    if (change === "map-replaced") expect(fake.map.getLayer("weather-owm-layer")).toBeDefined();
  },
);
