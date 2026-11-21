import type { Map as MaplibreMap } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { applyBasemapAdjustments } from "../web/basemap-adjustments";

const WOOD_OPACITY = {
  base: 1,
  stops: [
    [2, 0.5],
    [13, 0.5],
    [16, 0.45],
  ],
};

function fakeMap(paint: Record<string, Record<string, unknown>>) {
  const state = structuredClone(paint);
  const map = {
    getLayer: (id: string) => (state[id] ? { id } : undefined),
    getPaintProperty: (id: string, name: string) => state[id]?.[name],
    setPaintProperty: (id: string, name: string, value: unknown) => {
      if (!state[id]) throw new Error(`no layer ${id}`);
      state[id][name] = value;
    },
  };
  return { map: map as unknown as MaplibreMap, state };
}

const STYLE = {
  "landcover-wood": { "fill-color": "#b3efcb", "fill-opacity": WOOD_OPACITY },
  road_oneway: { "icon-opacity": 0.5 },
  road_oneway_opposite: { "icon-opacity": 0.5 },
};

describe("basemap adjustments", () => {
  it("deepens woods towards a canopy green and 0.85 opacity between zoom 15.5 and 16.5", () => {
    const { map, state } = fakeMap(STYLE);
    applyBasemapAdjustments(map, "light", false);
    expect(state["landcover-wood"]?.["fill-color"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      15.5,
      "#b3efcb",
      16.5,
      "#8fcca0",
    ]);
    expect(state["landcover-wood"]?.["fill-opacity"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      2,
      0.5,
      13,
      0.5,
      15.5,
      // The style's own opacity at 15.5, between its 13 and 16 stops.
      0.5 + (0.45 - 0.5) * (2.5 / 3),
      16.5,
      0.85,
    ]);
  });

  it("uses the dark canopy green in the dark style", () => {
    const { map, state } = fakeMap({
      "landcover-wood": { "fill-color": "#1f4030", "fill-opacity": 0.5 },
    });
    applyBasemapAdjustments(map, "dark", false);
    expect(state["landcover-wood"]?.["fill-color"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      15.5,
      "#1f4030",
      16.5,
      "#173322",
    ]);
    expect(state["landcover-wood"]?.["fill-opacity"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      15.5,
      0.5,
      16.5,
      0.85,
    ]);
  });

  it("fades one-way arrows out from zoom 16.5 to 17 only with street detail", () => {
    const without = fakeMap(STYLE);
    applyBasemapAdjustments(without.map, "light", false);
    expect(without.state.road_oneway?.["icon-opacity"]).toBe(0.5);
    const withDetail = fakeMap(STYLE);
    applyBasemapAdjustments(withDetail.map, "light", true);
    for (const id of ["road_oneway", "road_oneway_opposite"])
      expect(withDetail.state[id]?.["icon-opacity"]).toEqual([
        "interpolate",
        ["linear"],
        ["zoom"],
        16.5,
        0.5,
        17,
        0,
      ]);
  });

  it("restores the original values exactly", () => {
    const { map, state } = fakeMap(STYLE);
    const restore = applyBasemapAdjustments(map, "light", true);
    restore();
    expect(state).toEqual(STYLE);
  });

  it("skips missing layers and expressions it does not recognise", () => {
    const expression = ["case", ["has", "x"], "#000000", "#ffffff"];
    const { map, state } = fakeMap({
      "landcover-wood": {
        "fill-color": expression,
        "fill-opacity": { property: "x", stops: [[0, 1]] },
      },
    });
    const restore = applyBasemapAdjustments(map, "light", true);
    expect(state["landcover-wood"]).toEqual({
      "fill-color": expression,
      "fill-opacity": { property: "x", stops: [[0, 1]] },
    });
    restore();
  });

  it("leaves a value another style set alone when restoring", () => {
    const { map, state } = fakeMap(STYLE);
    const restore = applyBasemapAdjustments(map, "light", false);
    // A style swap replaced the layer with the new style's own value.
    (state["landcover-wood"] as Record<string, unknown>)["fill-color"] = "#123456";
    restore();
    expect(state["landcover-wood"]?.["fill-color"]).toBe("#123456");
  });
});
