import type { ExpressionSpecification } from "maplibre-gl";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import type { SchematicLayout, SchematicNetwork } from "./store";

export const SCHEMATIC_SOURCE_ID = "omx-schematic-transit-src";

/** LOOM encodes colors as bare hex ("FF3300", "fff") and widths as strings. */
const lineColor: ExpressionSpecification = ["concat", "#", ["get", "line-color"]];
const stationFill: ExpressionSpecification = ["concat", "#", ["get", "fillColor"]];
const stationOutline: ExpressionSpecification = ["concat", "#", ["get", "color"]];
const lineWidth: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  6,
  ["*", 0.5, ["to-number", ["get", "width"], 2]],
  11,
  ["to-number", ["get", "width"], 2],
  14,
  ["*", 1.6, ["to-number", ["get", "width"], 2]],
];

export function buildSchematicGroup(
  apiUrl: string,
  network: SchematicNetwork,
  layout: SchematicLayout,
): MapLayerGroup {
  return {
    sources: {
      [SCHEMATIC_SOURCE_ID]: {
        type: "vector",
        // No .mvt suffix: the offline service worker CacheFirst-caches \.pbf$ URLs
        // for 30 days, longer than the weekly upstream rebuild.
        tiles: [
          `${apiUrl}/api/integrations/overlay-schematic-transit/tiles/${network}/${layout}/{z}/{x}/{y}`,
        ],
        minzoom: 0,
        maxzoom: 14,
      },
    },
    layers: [
      {
        id: "omx-schematic-transit-connections",
        type: "line",
        source: SCHEMATIC_SOURCE_ID,
        "source-layer": "inner-connections",
        slot: "overlay-lines",
        order: 6,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": lineColor, "line-width": lineWidth, "line-opacity": 0.8 },
      },
      {
        id: "omx-schematic-transit-lines",
        type: "line",
        source: SCHEMATIC_SOURCE_ID,
        "source-layer": "lines",
        slot: "overlay-lines",
        order: 7,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": lineColor, "line-width": lineWidth },
      },
      {
        id: "omx-schematic-transit-station-fill",
        type: "fill",
        source: SCHEMATIC_SOURCE_ID,
        "source-layer": "stations",
        slot: "overlay-points",
        order: 6,
        paint: { "fill-color": stationFill },
      },
      {
        id: "omx-schematic-transit-station-outline",
        type: "line",
        source: SCHEMATIC_SOURCE_ID,
        "source-layer": "stations",
        slot: "overlay-points",
        order: 7,
        paint: { "line-color": stationOutline, "line-width": 1.5 },
      },
      {
        id: "omx-schematic-transit-station-labels",
        type: "symbol",
        source: SCHEMATIC_SOURCE_ID,
        "source-layer": "stations",
        slot: "overlay-markers",
        order: 6,
        minzoom: 11,
        layout: {
          "text-field": ["get", "stationLabel"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-anchor": "top",
          "text-offset": [0, 0.4],
          "text-optional": true,
        },
        paint: {
          "text-color": "#222222",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
        },
      },
    ],
  };
}
