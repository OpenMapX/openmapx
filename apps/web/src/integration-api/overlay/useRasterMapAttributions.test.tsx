import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, renderHook } from "@/test";
import { useMapAttributionStore } from "./mapAttributionStore";
import {
  type RasterAttributionDescriptor,
  useRasterMapAttributions,
} from "./useRasterMapAttributions";
import { useRenderedMapAttributions } from "./useRenderedMapAttributions";

let fake: FakeMap;
const MAP_REF = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: MAP_REF, mapReady: true, styleVersion: 0 }),
}));
const descriptors: RasterAttributionDescriptor[] = [
  {
    layerId: "active",
    sourceId: "supplier",
    contributors: [{ sourceId: "supplier", name: "successful-supplier" }],
  },
];
interface TestTile {
  hasData(): boolean;
  texture?: object;
  fadeOpacity: number;
  fadingParentID?: { key: string };
}
const loaded = (): TestTile => ({ hasData: () => true, texture: {}, fadeOpacity: 1 });
let retained: Map<string, TestTile>;
let visible: string[];
let evaluatedOpacity: number;
function installBridge() {
  // Mirror the non-underscore typed engine surface used by drawRaster. Cache
  // entries are deliberately separate from the painter's retained coordinates.
  Object.defineProperty(fake.map, "style", {
    configurable: true,
    value: {
      tileManagers: {
        supplier: {
          getVisibleCoordinates: () => visible.map((key) => ({ key })),
          getTile: (coord: { key: string }) => retained.get(coord.key),
          getLoadedTile: (coord: { key: string }) => retained.get(coord.key),
        },
      },
      getLayer: (id: string) =>
        fake.state.layers.has(id)
          ? { type: "raster", paint: { get: () => evaluatedOpacity } }
          : undefined,
    } as unknown as MapLibreMap["style"],
  });
}
function mountLayers() {
  fake.map.addSource("supplier", {
    type: "raster",
    tiles: ["https://tiles.example/{z}/{x}/{y}"],
    maxzoom: 8,
  });
  fake.map.addLayer({ id: "active", type: "raster", source: "supplier", minzoom: 5, maxzoom: 18 });
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
  retained = new Map();
  visible = [];
  evaluatedOpacity = 1;
  useMapAttributionStore.setState({ byLayer: {} });
  mountLayers();
  installBridge();
});
afterEach(() => vi.useRealTimers());

describe("effective raster contribution", () => {
  it("credits successful retained visible content even while other tiles are pending or errored", () => {
    renderHook(() => useRasterMapAttributions("weather", descriptors, true));
    retained.set("cached", loaded());
    retained.set("pending", { hasData: () => false, fadeOpacity: 1 });
    visible = ["cached", "pending"];
    fake.state.styleLoaded = false;
    act(() => fake.emit("error", { sourceId: "supplier", error: new Error("partial failure") }));
    flush();
    expect(html()).toContain("successful-supplier");
  });
  it("never credits a settled source whose first tile failed", () => {
    retained.set("failed", { hasData: () => false, fadeOpacity: 1 });
    visible = ["failed"];
    renderHook(() => useRasterMapAttributions("weather", descriptors, true));
    act(() => {
      fake.emit("error", { sourceId: "supplier" });
      fake.emit("idle");
    });
    flush();
    expect(html()).toBe("");
    retained.set("failed", loaded());
    flush();
    expect(html()).toContain("successful-supplier");
  });
  it("credits a zero-opacity child when the painter uses its retained cross-fade parent", () => {
    retained.set("child", { ...loaded(), fadeOpacity: 0, fadingParentID: { key: "parent" } });
    retained.set("parent", loaded());
    visible = ["child"];
    renderHook(() => useRasterMapAttributions("weather", descriptors, true));
    flush();
    expect(html()).toContain("successful-supplier");
    retained.delete("parent");
    flush();
    expect(html()).toBe("");
  });
  it("excludes cached offscreen and evicted tiles rather than trusting old success", () => {
    retained.set("old", loaded());
    visible = ["old"];
    renderHook(() => useRasterMapAttributions("weather", descriptors, true));
    flush();
    expect(html()).toContain("successful-supplier");
    visible = [];
    flush();
    expect(html()).toBe("");
    visible = ["old"];
    retained.delete("old");
    flush();
    expect(html()).toBe("");
  });
  it("excludes transparent preload layers and zero-opacity transition frames", () => {
    retained.set("active", loaded());
    visible = ["active"];
    evaluatedOpacity = 0;
    renderHook(() => useRasterMapAttributions("weather", descriptors, true));
    flush();
    expect(html()).toBe("");
    evaluatedOpacity = 0.4;
    flush();
    expect(html()).toContain("successful-supplier");
  });
  it("honors layer zoom and visibility while allowing source overzoom", () => {
    retained.set("active", loaded());
    visible = ["active"];
    renderHook(() => useRasterMapAttributions("weather", descriptors, true));
    flush();
    expect(html()).toContain("successful-supplier");
    fake.state.zoom = 18;
    flush();
    expect(html()).toBe("");
    fake.state.zoom = 4;
    flush();
    expect(html()).toBe("");
    fake.state.zoom = 10;
    fake.map.setLayoutProperty("active", "visibility", "none");
    flush();
    expect(html()).toBe("");
  });
  it("does not credit unrelated successful sources, missing texture or invisible fading content", () => {
    retained.set("no-texture", { hasData: () => true, fadeOpacity: 1 });
    visible = ["no-texture"];
    renderHook(() => useRasterMapAttributions("weather", descriptors, true));
    flush();
    expect(html()).toBe("");
    retained.set("no-texture", { ...loaded(), fadeOpacity: 0 });
    flush();
    expect(html()).toBe("");
    retained.set("no-texture", loaded());
    flush();
    expect(html()).toContain("successful-supplier");
    fake.state.layers.get("active")!.source = "other";
    flush();
    expect(html()).toBe("");
  });
  it("clears on style teardown and waits for replacement tile success", () => {
    retained.set("active", loaded());
    visible = ["active"];
    renderHook(() => useRasterMapAttributions("weather", descriptors, true));
    flush();
    expect(html()).toContain("successful-supplier");
    act(() => fake.map.setStyle({ version: 8, sources: {}, layers: [] }));
    flush();
    expect(html()).toBe("");
    retained.clear();
    visible = [];
    mountLayers();
    installBridge();
    flush();
    expect(html()).toBe("");
    retained.set("new", loaded());
    visible = ["new"];
    flush();
    expect(html()).toContain("successful-supplier");
  });
  it("reports an unavailable engine adapter once and never infers successful content", () => {
    retained.set("active", loaded());
    visible = ["active"];
    Object.defineProperty(fake.map, "style", { configurable: true, value: undefined });
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      renderHook(() => useRasterMapAttributions("weather", descriptors, true));
      flush();
      flush();
      expect(html()).toBe("");
      expect(diagnostic).toHaveBeenCalledTimes(1);
    } finally {
      diagnostic.mockRestore();
    }
  });
  it("uses evaluated layer visibility for conditional hidden rasters", () => {
    retained.set("active", loaded());
    visible = ["active"];
    fake.state.layers.get("active")!.isHidden = () => true;
    renderHook(() => useRasterMapAttributions("weather", descriptors, true));
    flush();
    expect(html()).toBe("");
    fake.state.layers.get("active")!.isHidden = () => false;
    flush();
    expect(html()).toContain("successful-supplier");
  });
  it("shares the scheduler with geometry owners and cleans up reused raster owner names independently", () => {
    retained.set("active", loaded());
    visible = ["active"];
    fake.map.addLayer({ id: "geometry", type: "circle", source: "points" });
    fake.setRenderedFeatures("geometry", [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [6, 51] },
        properties: { _mapAttributions: '[{"sourceId":"point","name":"point-credit"}]' },
      },
    ] as never);
    renderHook(() => useRenderedMapAttributions("points", ["geometry"], true));
    const first = renderHook(
      ({ active }) => useRasterMapAttributions("same", descriptors, active),
      { initialProps: { active: true } },
    );
    const second = renderHook(() => useRasterMapAttributions("same", descriptors, true));
    flush();
    expect(html()).toContain("successful-supplier");
    expect(html()).toContain("point-credit");
    expect(
      fake.state.listenerCalls.filter((entry) => entry.method === "on" && entry.event === "render"),
    ).toHaveLength(1);
    first.rerender({ active: false });
    expect(html()).toContain("successful-supplier");
    second.unmount();
    expect(html()).not.toContain("successful-supplier");
    expect(html()).toContain("point-credit");
  });
});
