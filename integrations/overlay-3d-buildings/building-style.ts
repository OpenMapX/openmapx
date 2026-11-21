import { isBuildingStyleLayer } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";

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
 * A calmer roof: the basemap roof is first lifted towards white in proportion
 * to its luminance, so light roofs read as pastel while dark-theme roofs
 * barely change. Then the OpenMapTiles `colour` field (OSM `building:colour`,
 * or a palette colour derived from `building:material`) is mixed in. Raw OSM
 * colours are often saturated CSS names, so they only tint the roof: about 25%
 * on a light roof, falling to about 8% on a dark one so a tagged white facade
 * does not glow in the dark theme. Unparseable values such as misspelt colour
 * names leave the lifted roof untinted.
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
  const lifted = (channel: number): maplibregl.ExpressionSpecification => [
    "+",
    ["at", channel, ["var", "roof"]],
    ["*", ["-", 255, ["at", channel, ["var", "roof"]]], ["var", "lift"]],
  ];
  const [red, green, blue] = RGBA_CHANNELS.map(
    (channel): maplibregl.ExpressionSpecification => [
      "+",
      ["*", ["at", channel, ["var", "tag"]], ["var", "weight"]],
      ["*", ["at", channel, ["var", "lifted"]], ["-", 1, ["var", "weight"]]],
    ],
  );

  // Each `let` sees only the bindings of the ones around it, hence the nesting.
  return [
    "let",
    "roof",
    ["to-rgba", roofColor],
    [
      "let",
      "lift",
      ["*", 0.3, roofLuminance],
      "weight",
      ["+", 0.08, ["*", 0.17, roofLuminance]],
      [
        "let",
        "liftedColor",
        ["rgb", lifted(0), lifted(1), lifted(2)],
        [
          "case",
          ["has", "colour"],
          [
            "let",
            "lifted",
            ["to-rgba", ["var", "liftedColor"]],
            // The fallback keeps a height-graded roof expression typed as a colour.
            "tag",
            ["to-rgba", ["to-color", ["get", "colour"], ["var", "liftedColor"]]],
            ["rgb", red, green, blue],
          ],
          ["var", "liftedColor"],
        ],
      ],
    ],
  ];
}

export const CONTACT_LAYER_ID = "openmapx-3d-buildings-contact";

/** A roof darker than this means a dark style, where the rim needs more weight to show. */
const DARK_ROOF_LUMINANCE = 0.35;

function hexLuminance(color: string | null): number | null {
  const match = color?.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const hex =
    (match[1] as string).length === 3
      ? [...(match[1] as string)].map((c) => c + c).join("")
      : (match[1] as string);
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return (0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number)) / 255;
}

/**
 * A soft dark rim on the ground around each building, drawn just below the
 * extrusions so the building covers its inner half: a cheap stand-in for the
 * contact shadow where walls meet the street.
 */
export function contactShadowPaint(
  roofColor: string | null,
  minZoom: number,
): maplibregl.LineLayerSpecification["paint"] {
  const luminance = hexLuminance(roofColor);
  const peak = luminance !== null && luminance < DARK_ROOF_LUMINANCE ? 0.2 : 0.12;
  const width: maplibregl.ExpressionSpecification = [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    17,
    3,
    20,
    24,
  ];
  return {
    "line-color": "#000000",
    "line-width": width,
    "line-blur": width,
    "line-opacity": ["interpolate", ["linear"], ["zoom"], minZoom, 0, minZoom + 0.5, peak],
  };
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
