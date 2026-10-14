import type { MapGeoJSONFeature, Map as MapLibreMap } from "maplibre-gl";
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
const credit = { sourceId: "exact", name: "exact-visible-credit" };
function feature(id?: number, marker = "exact"): MapGeoJSONFeature {
  return {
    type: "Feature",
    ...(id !== undefined ? { id } : {}),
    properties: { marker, _mapAttributions: JSON.stringify([credit]) },
    geometry: {
      type: "LineString",
      coordinates: [
        [5, 52],
        [6, 52],
      ],
    },
  } as unknown as MapGeoJSONFeature;
}
interface PaintTile {
  records: MapGeoJSONFeature[];
  gradients: Record<string, { gradient: { data: Uint8Array }; texture: object }>;
  ready: boolean;
  image: { width: number; height: number; data: Uint8Array };
  atlas: Record<string, { tlbr: [number, number, number, number] }>;
  query: ReturnType<typeof vi.fn>;
}
let retained: Map<string, PaintTile>;
let coordinates: string[];
function tile(records: MapGeoJSONFeature[], gradients: Record<string, number[]> = {}): PaintTile {
  return {
    records,
    gradients: Object.fromEntries(
      Object.entries(gradients).map(([id, alphas]) => [
        id,
        { gradient: { data: new Uint8Array(alphas.flatMap((a) => [255, 0, 0, a])) }, texture: {} },
      ]),
    ),
    ready: false,
    image: { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) },
    atlas: {},
    query: vi.fn(),
  };
}
function bridge() {
  Object.defineProperty(fake.map, "style", {
    configurable: true,
    value: {
      tileManagers: {
        data: {
          getVisibleCoordinates: () => coordinates.map((key) => ({ key })),
          getTile: ({ key }: { key: string }) => {
            const value = retained.get(key);
            if (!value) return undefined;
            return {
              hasData: () => true,
              querySourceFeatures: (records: MapGeoJSONFeature[]) => {
                value.query();
                records.push(...value.records);
              },
              getBucket: () => ({
                uploaded: true,
                isEmpty: () => false,
                gradients: value.gradients,
              }),
              patternsLoaded: () => value.ready,
              imageAtlasTexture: value.ready ? {} : undefined,
              imageAtlas: {
                image: value.image,
                patternPositions: value.atlas,
              },
            };
          },
        },
      },
    } as unknown as MapLibreMap["style"],
  });
}
function add(id: string, type: "line" | "fill", paint: Record<string, unknown>) {
  fake.map.addLayer({ id, type, source: "data", paint } as never);
  const layer = fake.state.layers.get(id);
  if (!layer) throw new Error("Missing layer fixture");
  layer.getCrossfadeParameters = () => ({ t: 1, fromScale: 1, toScale: 1 });
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
  coordinates = [];
  useMapAttributionStore.setState({ byLayer: {} });
  bridge();
});
afterEach(() => vi.useRealTimers());

describe("retained paint evidence", () => {
  it("rejects an entirely transparent gradient despite its evaluated boolean flag and opaque line-color", () => {
    add("gradient", "line", { "line-gradient": true, "line-color": { a: 1 } });
    const record = feature(1);
    fake.setRenderedFeatures("gradient", [record]);
    const value = tile([record], { gradient: [0, 0] });
    retained.set("visible", value);
    coordinates = ["visible"];
    renderHook(() => useRenderedMapAttributions("gradient", ["gradient"], true));
    flush();
    expect(html()).toBe("");
    const gradient = value.gradients.gradient;
    if (!gradient) throw new Error("Missing gradient fixture");
    gradient.gradient.data[3] = 255;
    gradient.gradient.data[7] = 255;
    flush();
    expect(html()).toContain("exact-visible-credit");
  });
  it("rejects a partial gradient without a bounded author contract", () => {
    add("gradient", "line", { "line-gradient": true });
    const record = feature(1);
    fake.setRenderedFeatures("gradient", [record]);
    retained.set("visible", tile([record], { gradient: [0, 255] }));
    coordinates = ["visible"];
    renderHook(() => useRenderedMapAttributions("gradient", ["gradient"], true));
    flush();
    expect(html()).toBe("");
  });
  it("accepts proven complementary layers only while all group members are live and subscribed", () => {
    add("traveled", "line", { "line-gradient": true });
    add("remaining", "line", { "line-gradient": true });
    const record = feature(1);
    fake.setRenderedFeatures("traveled", [record]);
    fake.setRenderedFeatures("remaining", [record]);
    retained.set("visible", tile([record], { traveled: [255, 0], remaining: [0, 255] }));
    coordinates = ["visible"];
    const hook = renderHook(
      ({ layers }) =>
        useRenderedMapAttributions("route", layers, true, {
          complementaryGradientGroups: [["traveled", "remaining"]],
        }),
      { initialProps: { layers: ["traveled", "remaining"] } },
    );
    flush();
    expect(html()).toContain("exact-visible-credit");
    fake.map.setLayoutProperty("remaining", "visibility", "none");
    flush();
    expect(html()).toBe("");
    fake.map.setLayoutProperty("remaining", "visibility", "visible");
    hook.rerender({ layers: ["traveled"] });
    flush();
    expect(html()).toBe("");
  });
  it.each(["line", "fill"] as const)(
    "does not fall back to opaque %s color when its declared pattern has not loaded",
    (type) => {
      add("pattern", type, {
        [`${type}-pattern`]: { from: { name: "hatch" }, to: { name: "hatch" } },
        [`${type}-color`]: { a: 1 },
      });
      const record = feature(1);
      fake.setRenderedFeatures("pattern", [record]);
      const value = tile([record]);
      retained.set("visible", value);
      coordinates = ["visible"];
      renderHook(() => useRenderedMapAttributions("pattern", ["pattern"], true));
      flush();
      expect(html()).toBe("");
      value.ready = true;
      value.atlas.hatch = { tlbr: [0, 0, 1, 1] };
      flush();
      expect(html()).toContain("exact-visible-credit");
    },
  );
  it("waits for the pattern's tile before crediting its independent opaque fill outline", () => {
    add("pattern", "fill", {
      "fill-pattern": "hatch",
      "fill-outline-color": { a: 1 },
      "fill-color": { a: 0 },
    });
    const record = feature(1);
    fake.setRenderedFeatures("pattern", [record]);
    const value = tile([record]);
    retained.set("visible", value);
    coordinates = ["visible"];
    renderHook(() => useRenderedMapAttributions("pattern", ["pattern"], true));
    flush();
    expect(html()).toBe("");
    value.ready = true;
    value.atlas.hatch = { tlbr: [0, 0, 1, 1] };
    flush();
    expect(html()).toContain("exact-visible-credit");
  });
  it.each([undefined, 42])(
    "does not borrow another tile's clipped geometry even with stable ID %s",
    (id) => {
      add("pattern", "line", { "line-pattern": "hatch" });
      const shown = feature(id);
      const other = feature(id);
      other.geometry = {
        type: "LineString",
        coordinates: [
          [7, 52],
          [8, 52],
        ],
      };
      const value = tile([other]);
      value.ready = true;
      value.atlas.hatch = { tlbr: [0, 0, 1, 1] };
      retained.set("other", value);
      coordinates = ["other"];
      fake.setRenderedFeatures("pattern", [shown]);
      renderHook(() => useRenderedMapAttributions("pattern", ["pattern"], true));
      flush();
      expect(html()).toBe("");
      value.records = [shown];
      flush();
      expect(html()).toContain("exact-visible-credit");
    },
  );
  it.each([
    ["line", 0, 255, 0, true],
    ["line", 1, 255, 0, false],
    ["line", 0.5, 255, 0, true],
    ["line", 0, 0, 255, false],
    ["line", 1, 0, 255, true],
    ["line", 0.5, 0, 255, true],
    ["fill", 0, 255, 0, true],
    ["fill", 1, 255, 0, false],
    ["fill", 0.5, 255, 0, true],
    ["fill", 0, 0, 255, false],
    ["fill", 1, 0, 255, true],
    ["fill", 0.5, 0, 255, true],
  ] as const)(
    "weights %s patterns at fade %s with alpha %s → %s (visible=%s)",
    (type, fade, from, to, expected) => {
      add("pattern", type, { [`${type}-pattern`]: { from: { name: "from" }, to: { name: "to" } } });
      const layer = fake.state.layers.get("pattern");
      if (!layer) throw new Error("Missing layer fixture");
      layer.getCrossfadeParameters = () => ({ t: fade, fromScale: 1, toScale: 1 });
      const record = feature(1);
      fake.setRenderedFeatures("pattern", [record]);
      const value = tile([record]);
      value.ready = true;
      value.image = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, from, 0, 255, 0, to]) };
      value.atlas.from = { tlbr: [0, 0, 1, 1] };
      value.atlas.to = { tlbr: [1, 0, 2, 1] };
      retained.set("visible", value);
      coordinates = ["visible"];
      renderHook(() => useRenderedMapAttributions("pattern", ["pattern"], true));
      flush();
      expect(html().includes("exact-visible-credit")).toBe(expected);
    },
  );
  it("keeps an independent fill outline visible after the active pattern endpoint becomes transparent", () => {
    add("pattern", "fill", {
      "fill-pattern": { from: { name: "from" }, to: { name: "to" } },
      "fill-outline-color": { a: 1 },
    });
    const record = feature(1);
    fake.setRenderedFeatures("pattern", [record]);
    const value = tile([record]);
    value.ready = true;
    value.image = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]) };
    value.atlas.from = { tlbr: [0, 0, 1, 1] };
    value.atlas.to = { tlbr: [1, 0, 2, 1] };
    retained.set("visible", value);
    coordinates = ["visible"];
    renderHook(() => useRenderedMapAttributions("pattern", ["pattern"], true));
    flush();
    expect(html()).toContain("exact-visible-credit");
  });
  it("matches only the feature's own retained tile and indexes each source-layer once per shared refresh", () => {
    add("pattern", "line", { "line-pattern": "hatch" });
    const shown = feature(undefined, "shown");
    const pending = tile([shown]);
    const unrelated = tile([feature(undefined, "other")]);
    unrelated.ready = true;
    unrelated.atlas.hatch = { tlbr: [0, 0, 1, 1] };
    retained.set("pending", pending);
    retained.set("other", unrelated);
    coordinates = ["pending", "other"];
    fake.setRenderedFeatures("pattern", [shown, shown]);
    renderHook(() => useRenderedMapAttributions("first", ["pattern"], true));
    renderHook(() => useRenderedMapAttributions("second", ["pattern"], true));
    flush();
    expect(html()).toBe("");
    expect(pending.query).toHaveBeenCalledTimes(1);
    expect(unrelated.query).toHaveBeenCalledTimes(1);
    pending.ready = true;
    pending.atlas.hatch = { tlbr: [0, 0, 1, 1] };
    fake.state.styleLoaded = false;
    flush();
    expect(html()).toContain("exact-visible-credit");
    coordinates = ["other"];
    flush();
    expect(html()).toBe("");
  });
});
