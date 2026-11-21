import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import type { PaintKind } from "../web/derive/roads";
import { PAINT_SOURCE_ID } from "../web/paint-protocol";
import {
  KIND_RANK,
  PAINT_LAYER_ID,
  PAINT_PALETTE,
  paintLayerSpec,
  paintOpacity,
} from "../web/paint-style";

const KINDS: PaintKind[] = [
  "surface",
  "surface_major",
  "rail_band",
  "bus",
  "cycle",
  "rail",
  "path_bridge_edge",
  "path_bridge",
  "pitch",
  "marking",
  "arrow",
];

function style(layer: unknown) {
  return {
    version: 8,
    sources: {
      [PAINT_SOURCE_ID]: { type: "vector", tiles: ["openmapx-street-detail://{z}/{x}/{y}"] },
    },
    layers: [layer],
  };
}

describe("paint style", () => {
  it("validates as a MapLibre style layer for both schemes", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(validateStyleMin(style(paintLayerSpec(scheme)) as never)).toEqual([]);
    }
  });

  it("is one fill layer from the paint source layer, from zoom 16.5, antialiased", () => {
    const spec = paintLayerSpec("light");
    expect(spec).toMatchObject({
      id: PAINT_LAYER_ID,
      type: "fill",
      source: PAINT_SOURCE_ID,
      "source-layer": "paint",
      minzoom: 16.5,
    });
    expect(spec.paint?.["fill-antialias"]).toBe(true);
    expect(PAINT_LAYER_ID).toBe("openmapx-street-detail-paint");
  });

  it("sorts by OSM layer, then by kind", () => {
    expect(KIND_RANK).toEqual(Object.fromEntries(KINDS.map((kind, rank) => [kind, rank])));
    const sortKey = paintLayerSpec("light").layout?.["fill-sort-key"] as unknown[];
    expect(sortKey.slice(0, 2)).toEqual(["+", ["*", ["get", "layer"], 100]]);
    const match = sortKey[2] as unknown[];
    expect(match.slice(0, 2)).toEqual(["match", ["get", "kind"]]);
    for (const kind of KINDS) {
      const at = match.indexOf(kind);
      expect(match[at + 1]).toBe(KIND_RANK[kind]);
    }
  });

  it("uses the basemap road colours, red bus and green cycle lanes, white or grey paint", () => {
    expect(PAINT_PALETTE.light).toEqual({
      surface: "#c7d5e2",
      surface_major: "#8ba5c1",
      bus: "#e8a49c",
      cycle: "#a9d8a0",
      rail_band: "#c8cfd6",
      rail: "#9aa3ad",
      path_bridge: "#c8c8c8",
      path_bridge_edge: "#b8c6d2",
      marking: "#ffffff",
      arrow: "#ffffff",
      pitch: "#ffffff",
    });
    expect(PAINT_PALETTE.dark).toEqual({
      surface: "#434b59",
      surface_major: "#5a6476",
      bus: "#7a3b36",
      cycle: "#2f5a3a",
      rail_band: "#39414e",
      rail: "#5b6472",
      path_bridge: "#3a414c",
      path_bridge_edge: "#12161d",
      marking: "#c9ced6",
      arrow: "#c9ced6",
      pitch: "#c9ced6",
    });
    const colour = paintLayerSpec("dark").paint?.["fill-color"] as unknown[];
    expect(colour[colour.indexOf("bus") + 1]).toBe("#7a3b36");
  });

  it("fades in from zoom 16.5 to 17, scaled by the tilt fade", () => {
    expect(paintOpacity(0.4)).toEqual(["interpolate", ["linear"], ["zoom"], 16.5, 0, 17, 0.4]);
    expect(
      validateStyleMin(
        style({ ...paintLayerSpec("light"), paint: { "fill-opacity": paintOpacity(1) } }) as never,
      ),
    ).toEqual([]);
  });
});
