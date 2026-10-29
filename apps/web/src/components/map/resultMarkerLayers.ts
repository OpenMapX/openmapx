import type { SymbolLayerSpecification } from "maplibre-gl";

/** Shared search and saved-list symbols, including zoom scaling and collision placement. */
export function resultMarkerLayers(
  source: string,
  markerId: string,
  labelId: string,
): [SymbolLayerSpecification, SymbolLayerSpecification] {
  return [
    {
      id: markerId,
      type: "symbol",
      source,
      layout: {
        "icon-image": ["get", "imageId"],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.45, 14, 0.6, 17, 0.85],
        "icon-allow-overlap": false,
        "icon-ignore-placement": false,
      },
    },
    {
      id: labelId,
      type: "symbol",
      source,
      minzoom: 15,
      layout: {
        "text-field": ["get", "name"],
        "text-size": 11,
        "text-offset": [0, 2.0],
        "text-anchor": "top",
        "text-max-width": 8,
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      },
      paint: {
        "text-color": "#B3261E",
        "text-halo-color": "#FFFFFF",
        "text-halo-width": 2,
      },
    },
  ];
}
