import { useLayerStore } from "@openmapx/core";
import { act, cleanup, render } from "@testing-library/react";
import type { Map as MapLibreMap, RasterDEMTileSource } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap, type FakeMap } from "@/test";
import { TerrainBaseLayer } from "./TerrainBaseLayer";

let fake: FakeMap;
const mapRef = {
  get current() {
    return fake.map;
  },
};
let terrain: { source: string; exaggeration: number } | null;
let exaggeration: number;
let opacity: number;
let transparentShade: boolean;
let transparentTint: boolean;
let tintExpression: { evaluate(): { a: number } };
let visible: string[];
let terrainVisible: string[];
interface TestTile {
  state: string;
  dem?: object;
  demTexture?: object;
  fbo?: object;
  needsHillshadePrepare: boolean;
  needsColorReliefPrepare: boolean;
  needsTerrainPrepare: boolean;
  hasData(): boolean;
  outcome: "success" | "failure" | "empty";
  tileID: { key: string };
}
let tiles: Map<string, TestTile>;
const env = {
  terrainDemTilejsonUrl: "https://example.test/dem.json",
  terrainDemTileUrlTemplate: "https://example.test/{z}/{x}/{y}.png",
  terrainDemEncoding: "terrarium",
  terrainContourMode: "generated",
  terrainContourTilejsonUrl: "",
  terrainAttributionName: "acquired-dem-notice",
  terrainAttributionUrl: "https://example.test/attribution",
};
vi.mock("./generatedContours", () => ({
  contourDemTileUrl: () => Promise.resolve("https://example.test/{z}/{x}/{y}.png"),
  generatedContourUrl: () => Promise.resolve("dem-contour://test/{z}/{x}/{y}"),
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@mui/material/styles", () => ({ useColorScheme: () => ({ mode: "light" }) }));
vi.mock("@/lib/offlineAreas", () => ({ useOfflinePackageActive: () => false }));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => env }));

const DEM = "openmapx-terrain-dem";
const SHADE_DEM = "openmapx-terrain-hillshade-dem";
const SUBTLE_DEM = "openmapx-default-relief-dem";
const CONTOURS = "openmapx-terrain-contours";
function flush() {
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
}
function html() {
  return Object.values(useMapAttributionStore.getState().byLayer).flat().join(" ");
}
function tile(key = "active"): TestTile {
  const value: TestTile = {
    state: "loading",
    outcome: "success",
    tileID: { key },
    needsHillshadePrepare: false,
    needsColorReliefPrepare: false,
    needsTerrainPrepare: false,
    hasData() {
      return ["loaded", "reloading", "expired"].includes(this.state);
    },
  };
  tiles.set(key, value);
  return value;
}
async function acquire(sourceId: string, value: TestTile) {
  const source = fake.map.getSource<RasterDEMTileSource>(sourceId);
  if (!source) throw new Error("missing source");
  await act(async () => {
    await source
      .loadTile(value as unknown as Parameters<RasterDEMTileSource["loadTile"]>[0])
      .catch(() => {});
  });
  value.demTexture = {};
  value.fbo = {};
  value.needsHillshadePrepare = false;
  value.needsColorReliefPrepare = false;
  value.needsTerrainPrepare = false;
  flush();
}
beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap();
  fake.state.zoom = 10;
  terrain = null;
  exaggeration = 0.35;
  opacity = 0.13;
  transparentShade = false;
  transparentTint = false;
  tintExpression = { evaluate: () => ({ a: transparentTint ? 0 : 1 }) };
  visible = ["active"];
  terrainVisible = ["active"];
  tiles = new Map();
  env.terrainAttributionName = "acquired-dem-notice";
  env.terrainDemTilejsonUrl = "https://example.test/dem.json";
  useMapAttributionStore.setState({ byLayer: {} });
  useLayerStore.getState().setActiveLayer("default");
  const addSource = fake.map.addSource.bind(fake.map);
  fake.map.addSource = ((id, specification) => {
    addSource(id, specification);
    const source = fake.map.getSource(id);
    if (specification.type === "raster-dem" && source) {
      Object.assign(source, {
        async loadTile(value: TestTile) {
          if (value.outcome === "failure") {
            value.state = "errored";
            throw new Error("tile unavailable");
          }
          if (value.outcome === "success") {
            value.dem = { data: new Uint8Array(4), dim: 1, get: () => 800 };
            value.needsHillshadePrepare = true;
            value.needsColorReliefPrepare = true;
            value.needsTerrainPrepare = true;
          }
          value.state = "loaded";
        },
      });
    }
    return fake.map;
  }) as typeof fake.map.addSource;
  Object.assign(fake.map, {
    getTerrain: () => terrain,
    setTerrain: (value: typeof terrain) => {
      terrain = value;
    },
  });
  Object.defineProperty(fake.map, "style", {
    configurable: true,
    value: {
      tileManagers: Object.fromEntries(
        [DEM, SHADE_DEM, SUBTLE_DEM].map((id) => [
          id,
          {
            getVisibleCoordinates: () => visible.map((key) => ({ key })),
            getTile: (coordinate: { key: string }) => tiles.get(coordinate.key),
          },
        ]),
      ),
      getLayer: (id: string) => {
        const layer = fake.state.layers.get(id);
        return layer
          ? {
              ...layer,
              colorRampExpression: tintExpression,
              paint: {
                get: (property: string) =>
                  property === "hillshade-exaggeration"
                    ? exaggeration
                    : property === "hillshade-accent-color"
                      ? { a: transparentShade ? 0 : 1 }
                      : property === "hillshade-highlight-color" ||
                          property === "hillshade-shadow-color"
                        ? { values: [{ a: transparentShade ? 0 : 1 }] }
                        : opacity,
              },
            }
          : undefined;
      },
    } as unknown as MapLibreMap["style"],
  });
  Object.defineProperty(fake.map, "terrain", {
    configurable: true,
    get: () =>
      terrain
        ? {
            exaggeration: terrain.exaggeration,
            tileManager: {
              getSource: () => fake.map.getSource(DEM),
              getRenderableTiles: () => terrainVisible.map((key) => ({ tileID: { key } })),
              getSourceTile: (coordinate: { key: string }) => tiles.get(coordinate.key),
            },
          }
        : null,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("terrain rendered contributor receipts", () => {
  it("withholds configured relief until a successful DEM actually prepares a visible surface", async () => {
    render(<TerrainBaseLayer />);
    flush();
    expect(html()).toBe("");
    const value = tile();
    value.outcome = "failure";
    await acquire(SUBTLE_DEM, value);
    expect(html()).toBe("");
    value.outcome = "empty";
    await acquire(SUBTLE_DEM, value);
    expect(html()).toBe("");
    value.outcome = "success";
    await acquire(SUBTLE_DEM, value);
    expect(html()).toContain("acquired-dem-notice");
    visible = [];
    flush();
    expect(html()).toBe("");
  });
  it("honors relief layer zoom rather than its lower DEM maximum zoom", async () => {
    render(<TerrainBaseLayer />);
    await acquire(SUBTLE_DEM, tile());
    fake.state.zoom = 5;
    flush();
    expect(html()).toBe("");
    fake.state.zoom = 12;
    flush();
    expect(html()).toContain("acquired-dem-notice");
    fake.state.zoom = 14;
    flush();
    expect(html()).toBe("");
  });
  it("drops zero-exaggeration and unprepared hillshade even with retained elevation", async () => {
    render(<TerrainBaseLayer />);
    const value = tile();
    await acquire(SUBTLE_DEM, value);
    exaggeration = 0;
    flush();
    expect(html()).toBe("");
    exaggeration = 0.35;
    value.fbo = undefined;
    flush();
    expect(html()).toBe("");
  });
  it("excludes hillshade whose evaluated lighting colors are all transparent", async () => {
    render(<TerrainBaseLayer />);
    await acquire(SUBTLE_DEM, tile());
    expect(html()).toContain("acquired-dem-notice");
    transparentShade = true;
    flush();
    expect(html()).toBe("");
  });
  it("keeps the successful content receipt during metadata changes and failed reloads", async () => {
    const view = render(<TerrainBaseLayer />);
    const value = tile();
    await acquire(SUBTLE_DEM, value);
    env.terrainAttributionName = "future-dem-notice";
    view.rerender(<TerrainBaseLayer />);
    value.outcome = "failure";
    await acquire(SUBTLE_DEM, value);
    expect(html()).toContain("acquired-dem-notice");
    expect(html()).not.toContain("future-dem-notice");
    value.outcome = "success";
    await acquire(SUBTLE_DEM, value);
    expect(html()).toContain("future-dem-notice");
    expect(html()).not.toContain("acquired-dem-notice");
  });
  it("keeps the mounted DEM supplier when a future configuration points to another URL", async () => {
    const view = render(<TerrainBaseLayer />);
    const value = tile();
    await acquire(SUBTLE_DEM, value);
    env.terrainAttributionName = "other-provider-notice";
    env.terrainDemTilejsonUrl = "https://other.test/dem.json";
    view.rerender(<TerrainBaseLayer />);
    await acquire(SUBTLE_DEM, value);
    expect(html()).toContain("acquired-dem-notice");
    expect(html()).not.toContain("other-provider-notice");
  });
  it("keeps a successfully acquired unknown supplier empty after metadata becomes known", async () => {
    env.terrainAttributionName = "";
    const view = render(<TerrainBaseLayer />);
    const value = tile();
    await acquire(SUBTLE_DEM, value);
    env.terrainAttributionName = "future-dem-notice";
    view.rerender(<TerrainBaseLayer />);
    flush();
    expect(html()).toBe("");
    await acquire(SUBTLE_DEM, value);
    expect(html()).toContain("future-dem-notice");
  });
  it("retains visible data while unrelated sources prevent styleLoaded and idle", async () => {
    render(<TerrainBaseLayer />);
    await acquire(SUBTLE_DEM, tile());
    fake.state.styleLoaded = false;
    flush();
    expect(html()).toContain("acquired-dem-notice");
  });
  it("credits only DEMs sampled by the current terrain mesh", async () => {
    useLayerStore.getState().setActiveLayer("terrain");
    render(<TerrainBaseLayer />);
    const value = tile();
    await acquire(DEM, value);
    fake.map.setLayoutProperty("openmapx-terrain-hillshade", "visibility", "none");
    fake.map.setLayoutProperty("openmapx-terrain-elevation-tint", "visibility", "none");
    flush();
    expect(html()).toContain("acquired-dem-notice");
    terrainVisible = [];
    flush();
    expect(html()).toBe("");
    terrainVisible = ["active"];
    if (terrain) terrain.exaggeration = 0;
    flush();
    expect(html()).toBe("");
  });
  it("requires prepared color relief with positive evaluated opacity", async () => {
    useLayerStore.getState().setActiveLayer("terrain");
    render(<TerrainBaseLayer />);
    await acquire(SHADE_DEM, tile());
    terrain = null;
    fake.map.setLayoutProperty("openmapx-terrain-hillshade", "visibility", "none");
    flush();
    expect(html()).toContain("acquired-dem-notice");
    opacity = 0;
    flush();
    expect(html()).toBe("");
  });
  it("excludes color-relief with a completely transparent native elevation ramp", async () => {
    useLayerStore.getState().setActiveLayer("terrain");
    render(<TerrainBaseLayer />);
    await acquire(SHADE_DEM, tile());
    terrain = null;
    fake.map.setLayoutProperty("openmapx-terrain-hillshade", "visibility", "none");
    flush();
    expect(html()).toContain("acquired-dem-notice");
    transparentTint = true;
    tintExpression = { evaluate: () => ({ a: 0 }) };
    flush();
    expect(html()).toBe("");
  });
  it("credits queried contours with their source generation receipt after metadata changes", async () => {
    useLayerStore.getState().setActiveLayer("terrain");
    const view = render(<TerrainBaseLayer />);
    await act(async () => {});
    flush();
    expect(html()).toBe("");
    env.terrainAttributionName = "future-dem-notice";
    view.rerender(<TerrainBaseLayer />);
    fake.setRenderedFeatures("openmapx-terrain-contour-lines", [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [6, 51],
            [6.1, 51],
          ],
        },
      },
    ] as never);
    flush();
    expect(html()).toContain("acquired-dem-notice");
    expect(html()).not.toContain("future-dem-notice");
    fake.map.removeLayer("openmapx-terrain-contour-lines");
    fake.map.removeLayer("openmapx-terrain-contour-labels");
    fake.map.removeSource(CONTOURS);
    flush();
    expect(html()).toBe("");
  });
});
