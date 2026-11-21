import type { Map as MaplibreMap } from "maplibre-gl";
import type { ColourScheme } from "./paint-style";

/**
 * Paint overrides on known OpenMapX basemap layers while the 3D view's map
 * details are active (spec §6.6). Values the module does not recognise are
 * left alone, and `restore` puts back exactly what it replaced.
 */

type PaintName = Parameters<MaplibreMap["getPaintProperty"]>[1];
type PaintValue = Parameters<MaplibreMap["setPaintProperty"]>[2];

const CANOPY: Record<ColourScheme, string> = { light: "#8fcca0", dark: "#173322" };
const WOOD_FROM = 15.5;
const WOOD_TO = 16.5;
const WOOD_OPACITY = 0.85;
const ONEWAY_FROM = 16.5;
const ONEWAY_TO = 17;

type Stops = { base?: number; stops: Array<[number, number]> };

function isStops(value: unknown): value is Stops {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const { stops, base } = value as { stops?: unknown; base?: unknown };
  return (
    keys.every((key) => key === "stops" || key === "base") &&
    (base === undefined || typeof base === "number") &&
    Array.isArray(stops) &&
    stops.length > 0 &&
    stops.every(
      (stop) =>
        Array.isArray(stop) &&
        stop.length === 2 &&
        typeof stop[0] === "number" &&
        typeof stop[1] === "number",
    )
  );
}

/** A legacy zoom function's value at `zoom` (MapLibre's exponential interpolation). */
function evaluateStops({ base = 1, stops }: Stops, zoom: number): number {
  const first = stops[0] as [number, number];
  const last = stops[stops.length - 1] as [number, number];
  if (zoom <= first[0]) return first[1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [z1, v1] = stops[i] as [number, number];
    const [z0, v0] = stops[i - 1] as [number, number];
    if (zoom > z1) continue;
    const t =
      base === 1 ? (zoom - z0) / (z1 - z0) : (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1);
    return v0 + (v1 - v0) * t;
  }
  return last[1];
}

/** The value rising from `from` (original) at `z0` to `to` at `z1`, or null if unrecognised. */
function rampTo(original: unknown, z0: number, z1: number, to: string | number): unknown | null {
  if (typeof original === "number" || typeof original === "string")
    return ["interpolate", ["linear"], ["zoom"], z0, original, z1, to];
  if (typeof to === "number" && isStops(original)) {
    const curve =
      original.base === undefined || original.base === 1
        ? ["linear"]
        : ["exponential", original.base];
    const before = original.stops.filter(([z]) => z < z0).flat();
    return ["interpolate", curve, ["zoom"], ...before, z0, evaluateStops(original, z0), z1, to];
  }
  return null;
}

/** Restores the replaced values; `isCurrent` tells whether the overrides are still in place. */
export type BasemapRestore = (() => void) & { isCurrent(): boolean };

/**
 * Apply the overrides and return a function that restores the replaced
 * values. Missing layers are skipped. Restoring leaves a value alone if
 * something else (a new style) has replaced the override since.
 */
export function applyBasemapAdjustments(
  map: MaplibreMap,
  scheme: ColourScheme,
  streetDetailPresent: boolean,
): BasemapRestore {
  const applied: Array<{
    layer: string;
    property: PaintName;
    original: PaintValue;
    value: PaintValue;
  }> = [];
  const adjust = (
    layer: string,
    property: PaintName,
    z0: number,
    z1: number,
    to: string | number,
  ) => {
    if (!map.getLayer(layer)) return;
    const original = map.getPaintProperty(layer, property) as PaintValue;
    const value = rampTo(original, z0, z1, to) as PaintValue | null;
    if (value === null) return;
    map.setPaintProperty(layer, property, value);
    applied.push({ layer, property, original, value });
  };
  adjust("landcover-wood", "fill-color", WOOD_FROM, WOOD_TO, CANOPY[scheme]);
  adjust("landcover-wood", "fill-opacity", WOOD_FROM, WOOD_TO, WOOD_OPACITY);
  if (streetDetailPresent)
    for (const layer of ["road_oneway", "road_oneway_opposite"])
      adjust(layer, "icon-opacity", ONEWAY_FROM, ONEWAY_TO, 0);

  const holds = (entry: (typeof applied)[number]) =>
    !!map.getLayer(entry.layer) &&
    JSON.stringify(map.getPaintProperty(entry.layer, entry.property)) ===
      JSON.stringify(entry.value);
  const restore = () => {
    for (const entry of applied)
      if (holds(entry)) map.setPaintProperty(entry.layer, entry.property, entry.original);
  };
  // Nothing applied (layers missing) counts as stale, so a later style is adjusted.
  return Object.assign(restore, { isCurrent: () => applied.length > 0 && applied.every(holds) });
}
