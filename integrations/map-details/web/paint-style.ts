import type { ExpressionSpecification, FillLayerSpecification } from "maplibre-gl";
import type { PaintKind } from "./derive/roads";
import { PAINT_SOURCE_ID } from "./paint-protocol";

/** The street paint fill layer (spec §6.5). */

export const PAINT_LAYER_ID = "openmapx-street-detail-paint";
/**
 * Zoom range over which the paint fades in. In 3D navigation it is fully drawn
 * by the camera's city cruising zoom (about z16.6), so the real-width route
 * lies on real-width roads between junctions too, not only near a turn.
 */
const PAINT_FADE = {
  full: { min: 16.5, full: 17 },
  navigation: { min: 16, full: 16.5 },
} as const;
export type PaintMode = keyof typeof PAINT_FADE;

/** The layer's minimum zoom in a mode. */
export function paintMinZoom(mode: PaintMode = "full"): number {
  return PAINT_FADE[mode].min;
}

/** Draw order within one OSM `layer`: surfaces first, markings and arrows last. */
export const KIND_RANK: Record<PaintKind, number> = {
  surface: 0,
  surface_major: 1,
  rail_band: 2,
  bus: 3,
  cycle: 4,
  rail: 5,
  path_bridge_edge: 6,
  path_bridge: 7,
  pitch: 8,
  marking: 9,
  arrow: 10,
};

export type ColourScheme = "light" | "dark";

/** Surfaces in the basemap's road colours (§5.2), lanes (§5.3), rails and bridges (§5.6). */
export const PAINT_PALETTE: Record<ColourScheme, Record<PaintKind, string>> = {
  light: {
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
  },
  dark: {
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
  },
};

function byKind(values: Record<PaintKind, string | number>, fallback: string | number) {
  return [
    "match",
    ["get", "kind"],
    ...Object.entries(values).flat(),
    fallback,
  ] as unknown as ExpressionSpecification;
}

/** Paint colour by kind for a colour scheme. */
export function paintColour(scheme: ColourScheme): ExpressionSpecification {
  return byKind(PAINT_PALETTE[scheme], PAINT_PALETTE[scheme].surface);
}

/** Fade in over the mode's zoom range, scaled by the tilt fade (0 flat … 1 tilted). */
export function paintOpacity(pitchFade: number, mode: PaintMode = "full"): ExpressionSpecification {
  const { min, full } = PAINT_FADE[mode];
  return ["interpolate", ["linear"], ["zoom"], min, 0, full, pitchFade];
}

export function paintLayerSpec(
  scheme: ColourScheme,
  mode: PaintMode = "full",
): FillLayerSpecification {
  return {
    id: PAINT_LAYER_ID,
    type: "fill",
    source: PAINT_SOURCE_ID,
    "source-layer": "paint",
    minzoom: paintMinZoom(mode),
    layout: {
      "fill-sort-key": ["+", ["*", ["get", "layer"], 100], byKind(KIND_RANK, 0)],
    },
    paint: {
      "fill-color": paintColour(scheme),
      "fill-opacity": paintOpacity(1, mode),
      "fill-antialias": true,
    },
  };
}
