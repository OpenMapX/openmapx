import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, renderHook } from "@/test";
import { useMapAttributionStore } from "./mapAttributionStore";
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
const LAYERS = ["incidents-marker", "incidents-line"];
const credit = (name: string) => ({
  sourceId: name,
  name,
  url: `https://${name}.example`,
  spdxLicense: "CC0-1.0",
});
function feature(names: string[]): MapGeoJSONFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [5, 52] },
    properties: { _mapAttributions: JSON.stringify(names.map(credit)) },
  } as unknown as MapGeoJSONFeature;
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
  fake.map.addLayer({ id: LAYERS[0]!, type: "symbol", source: "incidents", minzoom: 7 });
  fake.map.addLayer({ id: LAYERS[1]!, type: "line", source: "incidents", minzoom: 7 });
  useMapAttributionStore.setState({ byLayer: {} });
});
afterEach(() => vi.useRealTimers());

describe("rendered map attribution lifecycle", () => {
  it("keeps visible incident credits while unrelated sources are still loading", () => {
    fake.setRenderedFeatures(LAYERS[0]!, [feature(["still-visible"])]);
    renderHook(() => useRenderedMapAttributions("area", LAYERS, true));
    flush();
    fake.state.styleLoaded = false;
    act(() => fake.emit("sourcedata", { sourceId: "unrelated-loading-tiles" }));
    flush();
    expect(html()).toContain("still-visible");
  });
  it("credits the union of rendered markers and shared lines, deduplicating tile copies", () => {
    fake.setRenderedFeatures(LAYERS[0]!, [feature(["marker"]), feature(["marker"])]);
    fake.setRenderedFeatures(LAYERS[1]!, [feature(["line-a", "line-b"])]);
    renderHook(() => useRenderedMapAttributions("area", LAYERS, true));
    flush();
    expect(html()).toContain("marker");
    expect(html()).toContain("line-a");
    expect(html()).toContain("line-b");
    expect(useMapAttributionStore.getState().byLayer["rendered:area"]).toHaveLength(3);
  });

  it("updates during continuous navigation movement without requiring idle", () => {
    fake.setRenderedFeatures(LAYERS[0]!, [feature(["old"])]);
    renderHook(() => useRenderedMapAttributions("area", LAYERS, true));
    flush();
    fake.setRenderedFeatures(LAYERS[0]!, [feature(["new"])]);
    act(() => fake.emit("move"));
    flush();
    expect(html()).toContain("new");
    expect(html()).not.toContain("old");
  });

  it("credits symbols placed after the last source event and render query", () => {
    renderHook(() => useRenderedMapAttributions("area", LAYERS, true));
    act(() => fake.emit("sourcedata", { sourceId: "incidents" }));
    flush();
    expect(html()).toBe("");
    // MapLibre can finish cross-tile symbol placement on later frames without
    // another source event. Its idle event follows the final render.
    fake.setRenderedFeatures(LAYERS[0]!, [feature(["late-symbol"])]);
    act(() => {
      fake.emit("idle");
      vi.advanceTimersByTime(250);
    });
    expect(html()).toContain("late-symbol");
  });

  it("credits late symbol placement even when an unrelated source prevents idle", () => {
    renderHook(() => useRenderedMapAttributions("area", LAYERS, true));
    flush();
    fake.state.styleLoaded = false;
    fake.setRenderedFeatures(LAYERS[0]!, [feature(["late-without-idle"])]);
    // Placement frames need not emit sourcedata or move, and global pending
    // sources prevent idle. They still change the features actually drawn.
    flush();
    expect(html()).toContain("late-without-idle");
  });

  it("retains the rendered snapshot while a newer source payload is pending", () => {
    fake.setRenderedFeatures(LAYERS[0]!, [feature(["cached"])]);
    renderHook(() => useRenderedMapAttributions("area", LAYERS, true));
    flush();
    act(() => fake.emit("sourcedata", { sourceId: "incidents" }));
    flush();
    expect(html()).toContain("cached");
    fake.setRenderedFeatures(LAYERS[0]!, []);
    act(() => fake.emit("sourcedata", { sourceId: "incidents" }));
    flush();
    expect(html()).toBe("");
  });

  it("clears below minimum zoom, above maximum zoom, and when layers are hidden", () => {
    fake.setRenderedFeatures(LAYERS[0]!, [feature(["visible"])]);
    renderHook(() => useRenderedMapAttributions("area", LAYERS, true));
    flush();
    fake.state.zoom = 6;
    act(() => fake.emit("move"));
    flush();
    expect(html()).toBe("");
    fake.state.zoom = 10;
    fake.state.layers.get(LAYERS[0]!)!.maxzoom = 10;
    act(() => fake.emit("styledata"));
    flush();
    expect(html()).toBe("");
    fake.state.layers.get(LAYERS[0]!)!.maxzoom = 11;
    fake.map.setLayoutProperty(LAYERS[0]!, "visibility", "none");
    act(() => fake.emit("styledata"));
    flush();
    expect(html()).toBe("");
  });

  it("keeps independent owners and base credits intact on hide and unmount", () => {
    useMapAttributionStore.getState().setLayer("base", ["Base map credit"]);
    fake.setRenderedFeatures(LAYERS[0]!, [feature(["shared"])]);
    const area = renderHook(({ visible }) => useRenderedMapAttributions("area", LAYERS, visible), {
      initialProps: { visible: true },
    });
    const route = renderHook(() => useRenderedMapAttributions("route", LAYERS, true));
    flush();
    area.rerender({ visible: false });
    flush();
    expect(html()).toContain("shared");
    expect(html()).toContain("Base map credit");
    route.unmount();
    expect(html()).toBe("Base map credit");
    act(() => {
      fake.emit("move");
      fake.emit("render");
      vi.advanceTimersByTime(1000);
    });
    expect(html()).toBe("Base map credit");
  });

  it("clears through style teardown and restores credits after source replay", () => {
    fake.setRenderedFeatures(LAYERS[0]!, [feature(["replayed"])]);
    renderHook(() => useRenderedMapAttributions("area", LAYERS, true));
    flush();
    act(() => fake.map.setStyle({ version: 8, sources: {}, layers: [] }));
    flush();
    expect(html()).toBe("");
    fake.map.addLayer({ id: LAYERS[0]!, type: "symbol", source: "incidents" });
    act(() => fake.emit("sourcedata", { sourceId: "incidents" }));
    flush();
    expect(html()).toContain("replayed");
  });

  it("bounds queries during navigation frames and stops when rendering stops", () => {
    const query = vi.spyOn(fake.map, "queryRenderedFeatures");
    renderHook(() => useRenderedMapAttributions("area", LAYERS, true));
    flush();
    query.mockClear();
    act(() => {
      for (let i = 0; i < 60; i++) {
        fake.emit("move");
        fake.emit("render");
        vi.advanceTimersByTime(16);
      }
    });
    expect(query.mock.calls.length).toBeGreaterThan(0);
    expect(query.mock.calls.length).toBeLessThanOrEqual(5);
    act(() => vi.advanceTimersByTime(250));
    query.mockClear();
    act(() => vi.advanceTimersByTime(1000));
    expect(query).not.toHaveBeenCalled();
  });

  it("sanitizes credit markup and ignores malformed payloads without losing other credits", () => {
    const bad = feature([]);
    bad.properties._mapAttributions = "bad json";
    const unsafe = feature([]);
    unsafe.properties._mapAttributions = JSON.stringify([
      {
        sourceId: "unsafe",
        name: "unsafe",
        attributionText: '<script>evil()</script><a href="javascript:evil()">Publisher</a>',
      },
    ]);
    fake.setRenderedFeatures(LAYERS[0]!, [bad, unsafe, feature(["valid"])]);
    renderHook(() => useRenderedMapAttributions("area", LAYERS, true));
    flush();
    expect(html()).toContain("valid");
    expect(html()).not.toContain("<script");
    expect(html()).not.toContain("javascript:");
  });
});
