import type { Map as MapLibreMap } from "maplibre-gl";
import { addLayerWithinBasemap } from "@/integration-api/map/layerStack";
import { ensureUrlTileSource } from "@/integration-api/map/layerStyleUtils";

const DEM = "openmapx-terrain-dem";
const HILLSHADE_DEM = "openmapx-terrain-hillshade-dem";
const CONTOURS = "openmapx-terrain-contours";
const HILLSHADE = "openmapx-terrain-hillshade";
const CONTOUR_LINES = "openmapx-terrain-contour-lines";
const CONTOUR_LABELS = "openmapx-terrain-contour-labels";

export interface TerrainStyleOptions {
  demUrl: string;
  contoursUrl: string;
  dark: boolean;
}

/** Keep relief below vector roads and labels, including after a style swap. */
export function syncTerrainStyle(
  map: Pick<
    MapLibreMap,
    | "getSource"
    | "addSource"
    | "getLayer"
    | "addLayer"
    | "setLayoutProperty"
    | "getLayoutProperty"
    | "setPaintProperty"
    | "getPaintProperty"
    | "getTerrain"
    | "setTerrain"
    | "getStyle"
  >,
  enabled: boolean,
  { demUrl, contoursUrl, dark }: TerrainStyleOptions,
): void {
  if (!enabled) {
    if (map.getTerrain()?.source === DEM) map.setTerrain(null);
    for (const id of [HILLSHADE, CONTOUR_LINES, CONTOUR_LABELS]) {
      if (map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none") {
        map.setLayoutProperty(id, "visibility", "none");
      }
    }
    return;
  }

  ensureUrlTileSource(map, DEM, {
    type: "raster-dem",
    url: demUrl,
    tileSize: 512,
    encoding: "mapbox",
  });
  // MapLibre renders hillshade more reliably when its DEM source is separate
  // from the source used to displace the 3D terrain mesh.
  ensureUrlTileSource(map, HILLSHADE_DEM, {
    type: "raster-dem",
    url: demUrl,
    tileSize: 512,
    encoding: "mapbox",
  });
  ensureUrlTileSource(map, CONTOURS, { type: "vector", url: contoursUrl });

  if (!map.getLayer(HILLSHADE)) {
    addLayerWithinBasemap(
      map,
      {
        id: HILLSHADE,
        type: "hillshade",
        source: HILLSHADE_DEM,
        paint: {
          "hillshade-exaggeration": 0.35,
          "hillshade-shadow-color": dark ? "#263443" : "#687682",
          "hillshade-highlight-color": dark ? "#78848c" : "#ffffff",
          "hillshade-accent-color": dark ? "#3e5260" : "#a8b4a2",
        },
      },
      "before-water",
    );
  }
  if (!map.getLayer(CONTOUR_LINES)) {
    addLayerWithinBasemap(
      map,
      {
        id: CONTOUR_LINES,
        type: "line",
        source: CONTOURS,
        "source-layer": "contour",
        minzoom: 9,
        paint: {
          "line-color": dark ? "#b4a998" : "#786b60",
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.2, 13, 0.4],
          "line-width": ["case", [">=", ["get", "nth_line"], 5], 1.1, 0.5],
        },
      },
      "before-lines",
    );
  }
  if (!map.getLayer(CONTOUR_LABELS)) {
    addLayerWithinBasemap(
      map,
      {
        id: CONTOUR_LABELS,
        type: "symbol",
        source: CONTOURS,
        "source-layer": "contour",
        minzoom: 12,
        filter: [">=", ["get", "nth_line"], 5],
        layout: {
          "symbol-placement": "line",
          "text-field": ["concat", ["to-string", ["get", "height"]], " m"],
          "text-size": 10,
          "text-font": ["Noto Sans Regular"],
        },
        paint: {
          "text-color": dark ? "#c7bfb1" : "#74675b",
          "text-halo-color": dark ? "#1c2830" : "#f5f2e9",
          "text-halo-width": 1,
        },
      },
      "before-labels",
    );
  }

  for (const id of [HILLSHADE, CONTOUR_LINES, CONTOUR_LABELS]) {
    if (map.getLayoutProperty(id, "visibility") === "none") {
      map.setLayoutProperty(id, "visibility", "visible");
    }
  }
  const colors = [
    [HILLSHADE, "hillshade-shadow-color", dark ? "#263443" : "#687682"],
    [HILLSHADE, "hillshade-highlight-color", dark ? "#78848c" : "#ffffff"],
    [HILLSHADE, "hillshade-accent-color", dark ? "#3e5260" : "#a8b4a2"],
    [CONTOUR_LINES, "line-color", dark ? "#b4a998" : "#786b60"],
    [CONTOUR_LABELS, "text-color", dark ? "#c7bfb1" : "#74675b"],
    [CONTOUR_LABELS, "text-halo-color", dark ? "#1c2830" : "#f5f2e9"],
  ] as const;
  for (const [id, property, value] of colors) {
    if (map.getPaintProperty(id, property) !== value) map.setPaintProperty(id, property, value);
  }
  if (map.getTerrain()?.source !== DEM) map.setTerrain({ source: DEM, exaggeration: 1 });
}
