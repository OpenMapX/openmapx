import type { Map as MapLibreMap, RasterTileSource, SourceSpecification } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, renderHook } from "@/test";
import { useMapAttributionStore } from "./mapAttributionStore";
import { addAttributedRasterSource } from "./rasterMapContribution";
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
  return Object.values(useMapAttributionStore.getState().byLayer)
    .flat()
    .map((entry) => entry.fullHtml)
    .join(" ");
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
  it.each(
    [false, true].flatMap((replaceTexture) =>
      (["success", "absent", "abort", "fail", "failed-upload"] as const).map((outcome) => ({
        replaceTexture,
        outcome,
      })),
    ),
  )(
    "binds overlapping $outcome completions to actual bytes (replace texture: $replaceTexture)",
    async ({ replaceTexture, outcome }) => {
      type Tile = Parameters<RasterTileSource["loadTile"]>[0];
      const completions: Array<
        (mode?: "success" | "absent" | "abort" | "fail" | "failed-upload") => void
      > = [];
      const originalAdd = fake.map.addSource.bind(fake.map);
      fake.map.addSource = (id, specification) => {
        originalAdd(id, specification);
        const source = fake.map.getSource<RasterTileSource>(id);
        if (!source) throw new Error("missing source");
        source.loadTile = (tile) =>
          new Promise<void>((resolve, reject) => {
            const texture = { bytes: "" };
            const requestNumber = completions.length;
            completions.push((mode = "success") => {
              if (mode === "absent") {
                resolve();
                return;
              }
              if (mode === "abort") {
                tile.state = "unloaded";
                resolve();
                return;
              }
              if (mode === "fail") {
                tile.state = "errored";
                reject(new Error("failed request"));
                return;
              }
              // MapLibre assigns even a reused GPU texture before updating it, and
              // writes loaded only after the content upload succeeds.
              tile.texture = replaceTexture ? texture : tile.texture;
              if (mode === "failed-upload") {
                tile.state = "errored";
                reject(new Error("failed upload"));
                return;
              }
              tile.texture.bytes = String(requestNumber);
              tile.state = "loaded";
              resolve();
            });
          });
        return fake.map;
      };
      fake.map.removeSource("supplier");
      addAttributedRasterSource(
        fake.map,
        "supplier",
        { type: "raster", tiles: ["https://tiles.test/{z}/{x}/{y}"] },
        descriptors[0].contributors,
      );
      const source = fake.map.getSource<RasterTileSource>("supplier");
      if (!source) throw new Error("missing source");
      const tile = { ...loaded(), texture: { bytes: "" }, state: "loading" };
      tile.hasData = () => ["loaded", "reloading", "expired"].includes(tile.state);
      retained.set("active", tile);
      visible = ["active"];
      const hook = renderHook(
        ({ descriptors: current }) => useRasterMapAttributions("weather", current, true),
        { initialProps: { descriptors } },
      );
      const first = source.loadTile(tile as Tile);
      hook.rerender({
        descriptors: [
          {
            ...descriptors[0],
            contributors: [{ sourceId: "supplier", name: "replacement-notice" }],
          },
        ],
      });
      const second = source.loadTile(tile as Tile);
      completions[1]();
      await second;
      flush();
      expect(tile.texture.bytes).toBe("1");
      expect(html()).toContain("replacement-notice");
      completions[0](outcome);
      if (outcome === "fail" || outcome === "failed-upload") await expect(first).rejects.toThrow();
      else await first;
      if (outcome !== "success") {
        // The engine can later re-enter a renderable reload state without any
        // content acquisition. Its retained bytes must keep the successful newer
        // receipt, or no receipt when failed upload replaced the texture.
        tile.state = "reloading";
        flush();
        if (replaceTexture && outcome === "failed-upload") expect(html()).toBe("");
        else {
          expect(tile.texture.bytes).toBe("1");
          expect(html()).toContain("replacement-notice");
          expect(html()).not.toContain("successful-supplier");
        }
        return;
      }
      flush();
      expect(tile.texture.bytes).toBe("0");
      expect(html()).toContain("successful-supplier");
      expect(html()).not.toContain("replacement-notice");
      // An empty response returns without touching loaded/texture; success of
      // the Promise itself must not restamp the retained old bytes.
      const absent = source.loadTile(tile as Tile);
      completions[2]("absent");
      await absent;
      flush();
      expect(html()).toContain("successful-supplier");
      expect(html()).not.toContain("replacement-notice");
      const aborted = source.loadTile(tile as Tile);
      completions[3]("abort");
      await aborted;
      flush();
      expect(html()).toBe("");
      // A later real reload owns its own receipt; a still later failed load
      // changes engine state but must not pretend that new bytes were acquired.
      const successful = source.loadTile(tile as Tile);
      completions[4]();
      await successful;
      const failing = source.loadTile(tile as Tile);
      completions[5]("fail");
      await expect(failing).rejects.toThrow("failed request");
      tile.state = "reloading";
      flush();
      expect(html()).toContain("replacement-notice");
      const upload = source.loadTile(tile as Tile);
      completions[6]("failed-upload");
      await expect(upload).rejects.toThrow("failed upload");
      flush();
      expect(html()).toBe("");
    },
  );

  it("captures public loadTile before pending work, commits new content and preserves failures on the same texture", async () => {
    let complete: (() => void) | undefined;
    let reject: ((reason: Error) => void) | undefined;
    const originalAdd = fake.map.addSource.bind(fake.map);
    fake.map.addSource = (id: string, specification: SourceSpecification) => {
      originalAdd(id, specification);
      const source = fake.map.getSource<RasterTileSource>(id);
      if (!source) throw new Error("missing source");
      source.loadTile = (tile) =>
        new Promise<void>((resolve, fail) => {
          complete = () => {
            const pooledTexture = tile.texture;
            tile.texture = pooledTexture;
            tile.state = "loaded";
            resolve();
          };
          reject = fail;
        });
      return fake.map;
    };
    fake.map.removeSource("supplier");
    addAttributedRasterSource(
      fake.map,
      "supplier",
      { type: "raster", tiles: ["https://tiles.test/{z}/{x}/{y}"] },
      descriptors[0].contributors,
    );
    const source = fake.map.getSource<RasterTileSource>("supplier");
    if (!source) throw new Error("missing source");
    const tile = { ...loaded(), state: "loading" };
    tile.hasData = () => tile.state === "loaded" || tile.state === "reloading";
    retained.set("active", tile);
    visible = ["active"];
    const hook = renderHook(
      ({ descriptors: current }) => useRasterMapAttributions("weather", current, true),
      { initialProps: { descriptors } },
    );
    const load = () => source.loadTile(tile as Parameters<RasterTileSource["loadTile"]>[0]);
    const first = load();
    hook.rerender({
      descriptors: [
        { ...descriptors[0], contributors: [{ sourceId: "supplier", name: "replacement-notice" }] },
      ],
    });
    flush();
    expect(html()).toBe("");
    complete?.();
    await first;
    flush();
    expect(html()).toContain("successful-supplier");
    expect(html()).not.toContain("replacement-notice");
    tile.state = "reloading";
    const failing = load();
    reject?.(new Error("late failure"));
    await expect(failing).rejects.toThrow("late failure");
    flush();
    expect(html()).toContain("successful-supplier");
    const replacement = load();
    complete?.();
    await replacement;
    flush();
    expect(html()).toContain("replacement-notice");
    expect(html()).not.toContain("successful-supplier");
  });
  it("preserves captured retained receipts across a temporarily unavailable engine adapter", () => {
    retained.set("active", loaded());
    visible = ["active"];
    const hook = renderHook(
      ({ descriptors: current }) => useRasterMapAttributions("weather", current, true),
      { initialProps: { descriptors } },
    );
    flush();
    const style = fake.map.style;
    Object.defineProperty(fake.map, "style", { configurable: true, value: undefined });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      hook.rerender({
        descriptors: [
          {
            ...descriptors[0],
            contributors: [{ sourceId: "supplier", name: "replacement-notice" }],
          },
        ],
      });
      flush();
      expect(html()).toBe("");
      Object.defineProperty(fake.map, "style", { configurable: true, value: style });
      flush();
      expect(html()).toContain("successful-supplier");
      expect(html()).not.toContain("replacement-notice");
    } finally {
      warning.mockRestore();
    }
  });
  it("starts a new receipt generation for a reused source ID", () => {
    retained.set("old", loaded());
    visible = ["old"];
    const hook = renderHook(
      ({ descriptors: current }) => useRasterMapAttributions("weather", current, true),
      { initialProps: { descriptors } },
    );
    flush();
    fake.map.removeLayer("active");
    fake.map.removeSource("supplier");
    mountLayers();
    retained.clear();
    retained.set("pending", { hasData: () => false, fadeOpacity: 1 });
    visible = ["pending"];
    hook.rerender({
      descriptors: [
        { ...descriptors[0], contributors: [{ sourceId: "supplier", name: "replacement-notice" }] },
      ],
    });
    flush();
    expect(html()).toBe("");
    retained.set("pending", loaded());
    flush();
    expect(html()).toContain("replacement-notice");
    expect(html()).not.toContain("successful-supplier");
  });
  it("retains the acquisition receipt across metadata refresh, pending success and failed reload", () => {
    const tile = { hasData: () => false, fadeOpacity: 1, texture: undefined as object | undefined };
    retained.set("active", tile);
    visible = ["active"];
    const hook = renderHook(
      ({ descriptors: current }) => useRasterMapAttributions("weather", current, true),
      { initialProps: { descriptors } },
    );
    flush();
    hook.rerender({
      descriptors: [
        { ...descriptors[0], contributors: [{ sourceId: "supplier", name: "replacement-notice" }] },
      ],
    });
    tile.hasData = () => true;
    tile.texture = {};
    flush();
    expect(html()).toContain("successful-supplier");
    expect(html()).not.toContain("replacement-notice");
    fake.emit("error", { sourceId: "supplier" });
    flush();
    expect(html()).toContain("successful-supplier");
    retained.set("new", loaded());
    visible.push("new");
    flush();
    expect(html()).toContain("replacement-notice");
    expect(html()).toContain("successful-supplier");
  });
  it("keeps a fading parent's own receipt while a new child acquires current metadata", () => {
    retained.set("parent", loaded());
    visible = ["parent"];
    const hook = renderHook(
      ({ descriptors: current }) => useRasterMapAttributions("weather", current, true),
      { initialProps: { descriptors } },
    );
    flush();
    hook.rerender({
      descriptors: [
        { ...descriptors[0], contributors: [{ sourceId: "supplier", name: "replacement-notice" }] },
      ],
    });
    retained.set("child", { ...loaded(), fadeOpacity: 0, fadingParentID: { key: "parent" } });
    visible = ["child"];
    flush();
    expect(html()).toContain("successful-supplier");
    expect(html()).not.toContain("replacement-notice");
    const child = retained.get("child");
    if (child) child.fadeOpacity = 0.5;
    flush();
    expect(html()).toContain("successful-supplier");
    expect(html()).toContain("replacement-notice");
  });

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
    const layer = fake.state.layers.get("active");
    if (!layer) throw new Error("missing layer");
    layer.source = "other";
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
    const layer = fake.state.layers.get("active");
    if (!layer) throw new Error("missing layer");
    layer.isHidden = () => true;
    renderHook(() => useRasterMapAttributions("weather", descriptors, true));
    flush();
    expect(html()).toBe("");
    layer.isHidden = () => false;
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
