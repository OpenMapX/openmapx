import type maplibregl from "maplibre-gl";

export interface BuildingSourceReference {
  source: string;
  sourceLayer: string;
}

const BUILDING_SOURCE_LAYER_NAMES = new Set(["building", "buildings"]);

function isBuildingLayer(layer: maplibregl.LayerSpecification): boolean {
  if (!("source-layer" in layer) || typeof layer["source-layer"] !== "string") return false;

  const sourceLayer = layer["source-layer"].toLowerCase();
  return BUILDING_SOURCE_LAYER_NAMES.has(sourceLayer) || /buildings?/i.test(layer.id);
}

/**
 * Resolve the vector source that an existing building style layer actually uses.
 * Style order is intentional and deterministic: prefer the first visible match,
 * then fall back to the first hidden match so styles that initially hide their
 * building layer remain compatible.
 */
export function findBuildingSourceReference(map: maplibregl.Map): BuildingSourceReference | null {
  const style = map.getStyle();
  const sources = style.sources;
  const layers = style.layers;
  if (!sources || !layers) return null;

  const matches: Array<BuildingSourceReference & { hidden: boolean }> = [];
  for (const layer of layers) {
    if (!isBuildingLayer(layer) || !("source" in layer) || typeof layer.source !== "string") {
      continue;
    }

    const source = sources[layer.source];
    if (source?.type !== "vector") continue;

    matches.push({
      source: layer.source,
      sourceLayer: layer["source-layer"] as string,
      hidden: layer.layout?.visibility === "none",
    });
  }

  const match = matches.find((candidate) => !candidate.hidden) ?? matches[0];
  return match ? { source: match.source, sourceLayer: match.sourceLayer } : null;
}

export const EXTRUSION_HEIGHT: maplibregl.ExpressionSpecification = [
  "case",
  ["has", "render_height"],
  ["to-number", ["get", "render_height"], 3],
  ["has", "height"],
  ["to-number", ["get", "height"], 3],
  ["has", "building:levels"],
  ["*", ["to-number", ["get", "building:levels"], 1], 3],
  ["has", "levels"],
  ["*", ["to-number", ["get", "levels"], 1], 3],
  3,
];

export const EXTRUSION_BASE: maplibregl.ExpressionSpecification = [
  "case",
  ["has", "render_min_height"],
  ["to-number", ["get", "render_min_height"], 0],
  ["has", "min_height"],
  ["to-number", ["get", "min_height"], 0],
  ["has", "building:min_level"],
  ["*", ["to-number", ["get", "building:min_level"], 0], 3],
  ["has", "min_level"],
  ["*", ["to-number", ["get", "min_level"], 0], 3],
  0,
];

export const EXTRUSION_COLOR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  EXTRUSION_HEIGHT,
  0,
  "#d4d0cc",
  20,
  "#c8c4c0",
  60,
  "#b8b4b2",
  150,
  "#a8a6a8",
  300,
  "#9898a0",
];
