import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import { createHeatmapPaint, syncHeatmapLayer } from "./heatmapLayer";
import { layerRegistrations, unregisterLayerSlot } from "./layerStack";

function createMap() {
  const fake = createFakeMap();
  fake.map.addSource("earthquakes", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  fake.map.addSource("wildfires", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  return fake;
}

describe("heatmap layers", () => {
  afterEach(() => {
    for (const registration of layerRegistrations()) {
      unregisterLayerSlot(registration.id);
    }
  });

  it("builds the common paint around each source's weight domain", () => {
    expect(createHeatmapPaint("mag", 8)).toEqual({
      "heatmap-weight": ["interpolate", ["linear"], ["get", "mag"], 0, 0, 8, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 3],
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(0,0,0,0)",
        0.2,
        "#ffffb2",
        0.4,
        "#fecc5c",
        0.6,
        "#fd8d3c",
        0.8,
        "#f03b20",
        1,
        "#bd0026",
      ],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 9, 30],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 7, 1, 12, 0],
    });
    expect(createHeatmapPaint("frp", 1000)["heatmap-weight"]).toEqual([
      "interpolate",
      ["linear"],
      ["get", "frp"],
      0,
      0,
      1000,
      1,
    ]);
  });

  it("adds and removes heatmaps with their domain-specific layer order", () => {
    const { map, state } = createMap();

    syncHeatmapLayer(map, {
      enabled: true,
      layerId: "earthquakes-heatmap",
      sourceId: "earthquakes",
      weightProperty: "mag",
      weightMax: 8,
      order: 1,
    });
    expect(state.layers.get("earthquakes-heatmap")).toMatchObject({
      id: "earthquakes-heatmap",
      source: "earthquakes",
    });
    expect(state.paint.get("earthquakes-heatmap")?.["heatmap-weight"]).toEqual([
      "interpolate",
      ["linear"],
      ["get", "mag"],
      0,
      0,
      8,
      1,
    ]);
    expect(layerRegistrations().find(({ id }) => id === "earthquakes-heatmap")).toEqual({
      id: "earthquakes-heatmap",
      slot: "overlay-heat",
      order: 1,
    });

    syncHeatmapLayer(map, {
      enabled: false,
      layerId: "earthquakes-heatmap",
      sourceId: "earthquakes",
      weightProperty: "mag",
      weightMax: 8,
      order: 1,
    });
    expect(state.counts.removeLayer.get("earthquakes-heatmap")).toBe(1);
    expect(layerRegistrations().some(({ id }) => id === "earthquakes-heatmap")).toBe(false);
  });

  it("cleans up registration when MapLibre rejects a layer", () => {
    const { map } = createMap();
    vi.spyOn(map, "addLayer").mockImplementation(() => {
      throw new Error("style is reloading");
    });

    expect(() =>
      syncHeatmapLayer(map, {
        enabled: true,
        layerId: "wildfires-heatmap",
        sourceId: "wildfires",
        weightProperty: "frp",
        weightMax: 1000,
        order: 0,
      }),
    ).not.toThrow();
    expect(layerRegistrations().some(({ id }) => id === "wildfires-heatmap")).toBe(false);
  });

  it("can disable a registered heatmap after its source disappears", () => {
    const { map, state } = createMap();
    syncHeatmapLayer(map, {
      enabled: true,
      layerId: "wildfires-heatmap",
      sourceId: "wildfires",
      weightProperty: "frp",
      weightMax: 1000,
      order: 0,
    });
    map.removeSource("wildfires");

    syncHeatmapLayer(map, {
      enabled: false,
      layerId: "wildfires-heatmap",
      sourceId: "wildfires",
      weightProperty: "frp",
      weightMax: 1000,
      order: 0,
    });

    expect(state.layers.has("wildfires-heatmap")).toBe(false);
    expect(layerRegistrations().some(({ id }) => id === "wildfires-heatmap")).toBe(false);
  });
});
