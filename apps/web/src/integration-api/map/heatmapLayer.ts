"use client";

import type * as maplibregl from "maplibre-gl";

/**
 * The shared heatmap paint, scaled to one source's weight property. Declare the
 * layer in a `useMapLayerGroup` descriptor in the `overlay-heat` slot.
 */
export function createHeatmapPaint(
  weightProperty: string,
  weightMax: number,
): NonNullable<maplibregl.HeatmapLayerSpecification["paint"]> {
  return {
    "heatmap-weight": ["interpolate", ["linear"], ["get", weightProperty], 0, 0, weightMax, 1],
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
  };
}
