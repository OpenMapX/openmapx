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
  licensing: {
    version: 1,
    bindings: [
      { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC0-1.0" } },
    ],
  } as const,
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
  return Object.values(useMapAttributionStore.getState().byLayer)
    .flat()
    .map((entry) => entry.fullHtml)
    .join(" ");
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap();
  fake.map.addLayer({
    id: LAYERS[0]!,
    type: "symbol",
    source: "incidents",
    minzoom: 7,
    layout: { "icon-image": "pin" },
  });
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
    expect(
      Object.values(useMapAttributionStore.getState().byLayer)
        .flat()
        .map((entry) => entry.fullHtml),
    ).toHaveLength(3);
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
    useMapAttributionStore
      .getState()
      .setLayer("base", [
        { fullHtml: "Base map credit", visibleHtml: "Base map credit", logos: [] },
      ]);
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
    fake.map.addLayer({
      id: LAYERS[0]!,
      type: "symbol",
      source: "incidents",
      layout: { "icon-image": "pin" },
    });
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

describe("evaluated channels and captured receipts", () => {
  it.each<[string, Record<string, unknown>, Record<string, unknown>, boolean]>([
    ["line", { "line-color": { r: 0, g: 0, b: 0, a: 0 } }, {}, false],
    ["line", { "line-color": { r: 0, g: 0, b: 0, a: 0.4 } }, {}, true],
    ["line", { "line-layer-opacity": 0 }, {}, false],
    ["circle", { "circle-color": { a: 0 }, "circle-stroke-width": 0 }, {}, false],
    [
      "circle",
      { "circle-opacity": 0, "circle-stroke-width": 2, "circle-stroke-color": { a: 0 } },
      {},
      false,
    ],
    [
      "circle",
      { "circle-color": { a: 0 }, "circle-stroke-width": 2, "circle-stroke-color": { a: 1 } },
      {},
      true,
    ],
    ["fill", { "fill-color": { a: 0 }, "fill-outline-color": { a: 0 } }, {}, false],
    ["fill", { "fill-color": { a: 0 }, "fill-outline-color": { a: 1 } }, {}, true],
    [
      "fill",
      { "fill-color": { a: 0 }, "fill-outline-color": { a: 1 }, "fill-antialias": false },
      {},
      false,
    ],
    ["fill", { "fill-color": { a: 1 }, "fill-layer-opacity": 0 }, {}, false],
    [
      "fill-extrusion",
      { "fill-extrusion-color": { a: 0 }, "fill-extrusion-height": 0, "fill-extrusion-base": 0 },
      {},
      true,
    ],
    ["line", { "line-width": 0 }, {}, false],
    ["line", { "line-opacity": 0 }, {}, false],
    [
      "circle",
      { "circle-opacity": 0, "circle-stroke-width": 2, "circle-stroke-opacity": 1 },
      {},
      true,
    ],
    ["circle", { "circle-opacity": 0, "circle-stroke-width": 0 }, {}, false],
    ["circle", { "circle-radius": 0, "circle-stroke-width": 0 }, {}, false],
    [
      "symbol",
      { "icon-opacity": 0, "text-opacity": 1, "text-color": { a: 0 } },
      { "text-field": "label" },
      false,
    ],
    [
      "symbol",
      {
        "text-opacity": 1,
        "text-color": { a: 0 },
        "text-halo-width": 2,
        "text-halo-color": { a: 0 },
      },
      { "text-field": "label" },
      false,
    ],
    [
      "symbol",
      {
        "text-opacity": 1,
        "text-color": { a: 0 },
        "text-halo-width": 0,
        "text-halo-color": { a: 1 },
      },
      { "text-field": "label" },
      false,
    ],
    [
      "symbol",
      { "text-opacity": 1, "text-color": { a: 0 }, "text-halo-width": 2 },
      { "text-field": "label" },
      false,
    ],
    [
      "symbol",
      {
        "text-opacity": 1,
        "text-color": { a: 0 },
        "text-halo-width": 2,
        "text-halo-color": { a: 1 },
      },
      { "text-field": "label" },
      true,
    ],
    [
      "symbol",
      { "text-opacity": 1, "text-color": { a: 0 } },
      { "text-field": { sections: [{ text: "glyph", textColor: { a: 0 } }] } },
      false,
    ],
    [
      "symbol",
      { "text-opacity": 1, "text-color": { a: 0 } },
      { "text-field": { sections: [{ text: "glyph", textColor: { a: 1 } }] } },
      true,
    ],
    [
      "symbol",
      { "text-opacity": 1, "text-color": { a: 0 } },
      { "text-field": { sections: [{ text: "", image: { name: "badge", available: true } }] } },
      true,
    ],
    [
      "symbol",
      { "text-opacity": 1, "text-color": { a: 0 } },
      { "icon-image": "photo", "text-field": "label" },
      true,
    ],
    ["symbol", { "icon-opacity": 0, "text-opacity": 1 }, { "text-field": "label" }, true],
    ["symbol", { "icon-opacity": 1, "text-opacity": 0 }, { "text-field": "label" }, false],
    ["symbol", { "icon-opacity": 1 }, { "icon-image": "pin", "icon-size": 0 }, false],
    ["symbol", { "text-opacity": 1 }, { "text-field": "label", "text-size": 0 }, false],
    [
      "symbol",
      { "icon-opacity": 0, "text-opacity": 1 },
      { "icon-image": "pin", "text-field": { sections: [] } },
      false,
    ],
    [
      "symbol",
      { "icon-opacity": 0, "text-opacity": 1 },
      { "text-field": { sections: [{ text: "label" }] } },
      true,
    ],
    [
      "symbol",
      { "icon-opacity": 1, "text-opacity": 0 },
      { "icon-image": { name: "pin", available: false } },
      false,
    ],
    [
      "symbol",
      { "icon-opacity": 0, "text-opacity": 0 },
      { "icon-image": "pin", "text-field": "label" },
      false,
    ],
    ["heatmap", { "heatmap-weight": 0 }, {}, false],
    ["heatmap", { "heatmap-weight": 1, "heatmap-intensity": 0 }, {}, false],
    ["heatmap", { "heatmap-weight": 1, "heatmap-radius": 10 }, {}, true],
    ["fill", { "fill-opacity": 0 }, {}, false],
    ["fill", { "fill-opacity": 1 }, {}, true],
    ["fill-extrusion", { "fill-extrusion-opacity": 0 }, {}, false],
  ])("checks %s paint %j with layout %j (visible=%s)", (type, paint, layout, visible) => {
    fake.map.addLayer({ id: "channel", type, source: "data", paint, layout } as never);
    const rendered = feature(["channel-credit"]);
    if (type === "fill" || type === "fill-extrusion")
      rendered.geometry = {
        type: "Polygon",
        coordinates: [
          [
            [5, 52],
            [6, 52],
            [6, 53],
            [5, 52],
          ],
        ],
      };
    fake.setRenderedFeatures("channel", [rendered]);
    renderHook(() => useRenderedMapAttributions("channel", ["channel"], true));
    flush();
    expect(html().includes("channel-credit")).toBe(visible);
  });

  it("uses exact layer fallback only for missing metadata and respects an explicit empty receipt", () => {
    fake.map.addLayer({ id: "uniform", type: "circle", source: "data" });
    const noMetadata = feature([]);
    delete noMetadata.properties._mapAttributions;
    fake.setRenderedFeatures("uniform", [noMetadata]);
    renderHook(() =>
      useRenderedMapAttributions("uniform", ["uniform"], true, {
        layerContributors: { uniform: [credit("uniform-source")] },
      }),
    );
    flush();
    expect(html()).toContain("uniform-source");
    fake.setRenderedFeatures("uniform", [feature([])]);
    flush();
    expect(html()).toBe("");
  });

  it("projects only the selected field snapshot before serialized and uniform receipts", () => {
    fake.setRenderedFeatures(LAYERS[1]!, [feature(["all-fields"])]);
    const options = {
      layerContributors: { [LAYERS[1]!]: [credit("uniform")] },
      resolveFeatureContributors: () => [credit("geometry-only")],
    };
    const hook = renderHook(
      ({ resolve }) =>
        useRenderedMapAttributions("projection", LAYERS, true, {
          ...options,
          resolveFeatureContributors: resolve,
        }),
      {
        initialProps: {
          resolve: options.resolveFeatureContributors as () =>
            | ReturnType<typeof credit>[]
            | undefined,
        },
      },
    );
    flush();
    expect(html()).toContain("geometry-only");
    expect(html()).not.toContain("all-fields");
    hook.rerender({ resolve: () => [] });
    flush();
    expect(html()).toBe("");
    hook.rerender({ resolve: () => undefined });
    flush();
    expect(html()).toContain("all-fields");
    expect(html()).not.toContain("uniform");
  });

  it("preserves overzoom beyond source max while enforcing the layer max", () => {
    fake.map.addSource("data", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      maxzoom: 8,
    });
    fake.map.addLayer({ id: "overzoom", type: "circle", source: "data", maxzoom: 15 });
    fake.setRenderedFeatures("overzoom", [feature(["overzoom"])]);
    renderHook(() => useRenderedMapAttributions("overzoom", ["overzoom"], true));
    flush();
    expect(html()).toContain("overzoom");
    fake.state.zoom = 15;
    flush();
    expect(html()).toBe("");
  });

  it("routes each layer hit only to subscribed owners and updates options without new listeners", () => {
    fake.map.addLayer({ id: "other", type: "circle", source: "data" });
    fake.setRenderedFeatures("other", [feature(["other-credit"])]);
    fake.setRenderedFeatures(LAYERS[1]!, [feature(["incident-credit"])]);
    const first = renderHook(({ active }) => useRenderedMapAttributions("first", LAYERS, active), {
      initialProps: { active: true },
    });
    renderHook(() => useRenderedMapAttributions("second", ["other"], true));
    flush();
    const byLayer = useMapAttributionStore.getState().byLayer;
    expect(
      Object.entries(byLayer)
        .find(([key]) => key.startsWith("rendered:first::"))?.[1]
        .map((entry) => entry.fullHtml)
        .join(" ") ?? "",
    ).not.toContain("other-credit");
    first.rerender({ active: false });
    expect(html()).not.toContain("incident-credit");
    expect(html()).toContain("other-credit");
    expect(
      fake.state.listenerCalls.filter((entry) => entry.method === "on" && entry.event === "render"),
    ).toHaveLength(1);
  });
});

describe("map instance replacement", () => {
  it("moves the owner to the new map and removes the old map's scheduler", () => {
    fake.setRenderedFeatures(LAYERS[1]!, [feature(["old-map"])]);
    const hook = renderHook(() => useRenderedMapAttributions("replacement", LAYERS, true));
    flush();
    expect(html()).toContain("old-map");
    const old = fake;
    fake = createFakeMap();
    fake.map.addLayer({ id: LAYERS[1]!, type: "line", source: "incidents" });
    fake.setRenderedFeatures(LAYERS[1]!, [feature(["new-map"])]);
    hook.rerender();
    flush();
    expect(html()).toContain("new-map");
    expect(html()).not.toContain("old-map");
    expect(old.state.handlers.get("render")?.size ?? 0).toBe(0);
  });
});

describe("evaluated heatmap ramp", () => {
  it("does not credit a kernel whose entire evaluated color ramp is transparent", () => {
    fake.map.addLayer({
      id: "density",
      type: "heatmap",
      source: "data",
      paint: { "heatmap-weight": 1, "heatmap-radius": 25 },
    });
    fake.state.layers.get("density")!.colorRamp = {
      data: new Uint8Array([255, 0, 0, 0, 0, 255, 0, 0]),
    };
    fake.setRenderedFeatures("density", [feature(["density-source"])]);
    renderHook(() => useRenderedMapAttributions("density", ["density"], true));
    flush();
    expect(html()).toBe("");
    fake.state.layers.get("density")!.colorRamp = {
      data: new Uint8Array([255, 0, 0, 0, 0, 255, 0, 255]),
    };
    flush();
    expect(html()).toContain("density-source");
  });
});
