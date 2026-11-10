import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import nauticalManifest from "../overlay-nautical/manifest.json";
import { useNauticalStore } from "../overlay-nautical/store";
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
  useOptionalEnv: () => ({ apiUrl: "https://api.test" }),
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { NauticalLayer } from "../overlay-nautical/map-layer";
import { WeatherLayer } from "./map-layer";

const entries = (manifests: Array<{ id: string }>) =>
  manifests.map((m) => ({ ...m, name: m.id, enabled: true, isBuiltIn: true })) as never;
const emptyRegistry = new IntegrationRegistry([]);
const loadedRegistry = new IntegrationRegistry(entries([weatherManifest, nauticalManifest]));

type Tile = {
  state: string;
  texture?: object;
  hasData(): boolean;
  fadeOpacity: number;
};
const tiles = new Map<string, Tile>();
const addSourceCalls: string[] = [];
const removeSourceCalls: string[] = [];

/** Sources behave like the engine's: loadTile commits a texture and then "loaded". */
function installEngineLikeSources() {
  const addSource = fake.map.addSource.bind(fake.map);
  fake.map.addSource = ((id: string, spec: never) => {
    addSourceCalls.push(id);
    addSource(id, spec);
    const source = fake.map.getSource(id) as unknown as {
      loadTile: (tile: Tile) => Promise<void>;
    };
    source.loadTile = async (tile) => {
      tile.texture = {};
      tile.state = "loaded";
    };
    return fake.map;
  }) as never;
  const removeSource = fake.map.removeSource.bind(fake.map);
  fake.map.removeSource = ((id: string) => {
    removeSourceCalls.push(id);
    return removeSource(id);
  }) as never;
  Object.defineProperty(fake.map, "style", {
    configurable: true,
    value: {
      getLayer: (id: string) => {
        const layer = fake.state.layers.get(id);
        return layer ? { type: layer.type, paint: { get: () => 1 } } : undefined;
      },
      tileManagers: new Proxy(
        {},
        {
          get: (_t, id: string) => ({
            getVisibleCoordinates: () => [{ key: id }],
            getTile: () => tiles.get(id),
          }),
        },
      ),
    },
  });
}

async function acquireTile(sourceId: string) {
  const tile: Tile = {
    state: "loading",
    hasData: () => tile.state === "loaded",
    fadeOpacity: 1,
  };
  tiles.set(sourceId, tile);
  const source = fake.map.getSource(sourceId) as unknown as {
    loadTile: (t: Tile) => Promise<void>;
  };
  await source.loadTile(tile);
}

function flush() {
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
}
function html() {
  return Object.values(useMapAttributionStore.getState().byLayer)
    .flat()
    .map((entry) => entry.fullHtml)
    .join(" ");
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap();
  tiles.clear();
  addSourceCalls.length = 0;
  removeSourceCalls.length = 0;
  installEngineLikeSources();
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

function withRegistry(registry: IntegrationRegistry, children: ReactNode) {
  return (
    <IntegrationRegistryContext.Provider value={registry}>
      {children}
    </IntegrationRegistryContext.Provider>
  );
}

it("credits an OpenWeatherMap layer shown before the registry loaded, without rebuilding it", async () => {
  useWeatherStore.setState({
    layerVisible: true,
    activeSubLayer: "temperature",
    owmAvailable: true,
    radarPastFrames: [],
    radarNowcastFrames: [],
  });
  const { rerender } = render(withRegistry(emptyRegistry, <WeatherLayer />));
  const source = fake.map.getSource("weather-owm-source");
  expect(source).toBeDefined();
  await acquireTile("weather-owm-source");
  flush();
  expect(html()).toBe("");
  const layerAdds = fake.state.counts.addLayer.get("weather-owm-layer");

  // The registry arrives while the same layer stays mounted.
  rerender(withRegistry(loadedRegistry, <WeatherLayer />));
  flush();

  expect(html()).toContain("OpenWeather");
  expect(fake.map.getSource("weather-owm-source")).toBe(source);
  expect(fake.state.counts.addLayer.get("weather-owm-layer")).toBe(layerAdds);
  expect(fake.state.counts.removeLayer.get("weather-owm-layer") ?? 0).toBe(0);
  expect(removeSourceCalls).toEqual([]);
});

it("credits a seamark layer shown before the registry loaded, without rebuilding it", async () => {
  useNauticalStore.setState({
    panelOpen: true,
    layerVisible: true,
    showSeamarks: true,
    showDepth: false,
    showNoaaCharts: false,
    showHarbors: false,
    showTideStations: false,
  });
  const { rerender } = render(withRegistry(emptyRegistry, <NauticalLayer />));
  const sourceId = "openmapx-nautical-seamark-source";
  const layerId = "openmapx-nautical-seamark-layer";
  const source = fake.map.getSource(sourceId);
  expect(source).toBeDefined();
  await acquireTile(sourceId);
  flush();
  expect(html()).toBe("");
  const adds = [...addSourceCalls];
  const layerAdds = fake.state.counts.addLayer.get(layerId);

  rerender(withRegistry(loadedRegistry, <NauticalLayer />));
  flush();

  expect(html()).toContain("OpenSeaMap");
  expect(fake.map.getSource(sourceId)).toBe(source);
  expect(addSourceCalls).toEqual(adds);
  expect(fake.state.counts.addLayer.get(layerId)).toBe(layerAdds);
  expect(fake.state.counts.removeLayer.get(layerId) ?? 0).toBe(0);
  expect(removeSourceCalls).toEqual([]);
});
