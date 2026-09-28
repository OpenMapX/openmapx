import type * as maplibregl from "maplibre-gl";
import { isBuildingStyleLayer } from "@/integration-api/map/buildingStyle";

export interface BuildingSourceReference {
  source: string;
  sourceLayer: string;
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
    if (!isBuildingStyleLayer(layer) || !("source" in layer) || typeof layer.source !== "string") {
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

/** Match the visible roof to the basemap, including its dark theme. */
export function findBuildingRoofColor(
  map: maplibregl.Map,
  reference: BuildingSourceReference,
): string | null {
  const layers = map.getStyle().layers ?? [];
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index];
    if (
      layer.type !== "fill" ||
      layer.source !== reference.source ||
      layer["source-layer"] !== reference.sourceLayer
    ) {
      continue;
    }
    const color = layer.paint?.["fill-color"];
    if (typeof color === "string") return color;
  }
  return null;
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

const RGBA_CHANNELS = [0, 1, 2] as const;

/**
 * Tint the roof with the OpenMapTiles `colour` field (OSM `building:colour`,
 * or a palette colour derived from `building:material`). Raw OSM colours are
 * often saturated CSS names, so they are only mixed into the basemap roof:
 * about 45% on a light roof, falling to about 12% on a dark one so a tagged
 * white facade does not glow in the dark theme. Unparseable values such as
 * misspelt colour names fall back to the untinted roof.
 */
export function buildingExtrusionColor(
  roof: string | maplibregl.ExpressionSpecification,
): maplibregl.ExpressionSpecification {
  const roofColor: maplibregl.ExpressionSpecification =
    typeof roof === "string" ? ["to-color", roof] : roof;
  const roofLuminance: maplibregl.ExpressionSpecification = [
    "/",
    [
      "+",
      ["*", 0.2126, ["at", 0, ["var", "roof"]]],
      ["*", 0.7152, ["at", 1, ["var", "roof"]]],
      ["*", 0.0722, ["at", 2, ["var", "roof"]]],
    ],
    255,
  ];
  const [red, green, blue] = RGBA_CHANNELS.map(
    (channel): maplibregl.ExpressionSpecification => [
      "+",
      ["*", ["at", channel, ["var", "tag"]], ["var", "weight"]],
      ["*", ["at", channel, ["var", "roof"]], ["-", 1, ["var", "weight"]]],
    ],
  );

  return [
    "case",
    ["has", "colour"],
    [
      "let",
      "roof",
      ["to-rgba", roofColor],
      [
        "let",
        // The rgba fallback keeps a height-graded roof expression typed as a colour.
        "tag",
        ["to-rgba", ["to-color", ["get", "colour"], ["var", "roof"]]],
        "weight",
        ["+", 0.12, ["*", 0.33, roofLuminance]],
        ["rgb", red, green, blue],
      ],
    ],
    roofColor,
  ];
}

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
