import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";
import { addLayerWithinBasemap } from "@/integration-api/map/layerStack";
import { ensureUrlTileSource } from "@/integration-api/map/layerStyleUtils";

const DEM = "openmapx-terrain-dem";
const HILLSHADE_DEM = "openmapx-terrain-hillshade-dem";
const CONTOURS = "openmapx-terrain-contours";
const ELEVATION_TINT = "openmapx-terrain-elevation-tint";
const HILLSHADE = "openmapx-terrain-hillshade";
const CONTOUR_LINES = "openmapx-terrain-contour-lines";
const CONTOUR_LABELS = "openmapx-terrain-contour-labels";

export interface TerrainStyleOptions {
  demUrl: string;
  contoursUrl: string;
  dark: boolean;
  demEncoding?: "mapbox" | "terrarium";
  generatedContourUrl?: string;
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
  { demUrl, contoursUrl, dark, demEncoding = "mapbox", generatedContourUrl }: TerrainStyleOptions,
): void {
  if (!enabled) {
    if (map.getTerrain()?.source === DEM) map.setTerrain(null);
    for (const id of [ELEVATION_TINT, HILLSHADE, CONTOUR_LINES, CONTOUR_LABELS]) {
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
    encoding: demEncoding,
  });
  // MapLibre renders hillshade more reliably when its DEM source is separate
  // from the source used to displace the 3D terrain mesh.
  ensureUrlTileSource(map, HILLSHADE_DEM, {
    type: "raster-dem",
    url: demUrl,
    tileSize: 512,
    encoding: demEncoding,
  });
  const hasContours = Boolean(generatedContourUrl || contoursUrl);
  if (hasContours) {
    ensureUrlTileSource(
      map,
      CONTOURS,
      generatedContourUrl
        ? { type: "vector", tiles: [generatedContourUrl], maxzoom: 15 }
        : { type: "vector", url: contoursUrl },
    );
  }

  const elevationTint: ExpressionSpecification = [
    "interpolate",
    ["linear"],
    ["elevation"],
    0,
    "rgba(0, 0, 0, 0)",
    400,
    "rgba(0, 0, 0, 0)",
    800,
    dark ? "#516552" : "#9dbb9a",
    1800,
    dark ? "#746b59" : "#d7c9a7",
    3000,
    dark ? "#91979b" : "#ece8dd",
    4500,
    dark ? "#adb8bd" : "#ffffff",
  ];
  if (!map.getLayer(ELEVATION_TINT)) {
    addLayerWithinBasemap(
      map,
      {
        id: ELEVATION_TINT,
        type: "color-relief",
        source: HILLSHADE_DEM,
        minzoom: 6,
        maxzoom: 13,
        paint: {
          "color-relief-color": elevationTint,
          "color-relief-opacity": dark ? 0.09 : 0.13,
        },
      },
      "before-water",
    );
  }

  if (!map.getLayer(HILLSHADE)) {
    addLayerWithinBasemap(
      map,
      {
        id: HILLSHADE,
        type: "hillshade",
        source: HILLSHADE_DEM,
        paint: {
          "hillshade-method": "multidirectional",
          "hillshade-exaggeration": 0.35,
          "hillshade-shadow-color": dark
            ? ["#263443", "#304351", "#263443", "#304351"]
            : ["#687682", "#89947f", "#687682", "#89947f"],
          "hillshade-highlight-color": dark
            ? ["#78848c", "#74868e", "#78848c", "#74868e"]
            : ["#ffffff", "#f5f4e9", "#ffffff", "#f5f4e9"],
          "hillshade-illumination-direction": [270, 315, 0, 45],
          "hillshade-illumination-altitude": [30, 30, 30, 30],
          "hillshade-accent-color": dark ? "#3e5260" : "#a8b4a2",
        },
      },
      "before-water",
    );
  }
  if (hasContours && !map.getLayer(CONTOUR_LINES)) {
    addLayerWithinBasemap(
      map,
      {
        id: CONTOUR_LINES,
        type: "line",
        source: CONTOURS,
        "source-layer": generatedContourUrl ? "contours" : "contour",
        minzoom: 9,
        paint: {
          "line-color": dark ? "#b4a998" : "#786b60",
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.2, 13, 0.4],
          "line-width": generatedContourUrl
            ? ["case", [">", ["get", "level"], 0], 1.1, 0.5]
            : ["case", [">=", ["get", "nth_line"], 5], 1.1, 0.5],
        },
      },
      "before-lines",
    );
  }
  if (hasContours && !map.getLayer(CONTOUR_LABELS)) {
    addLayerWithinBasemap(
      map,
      {
        id: CONTOUR_LABELS,
        type: "symbol",
        source: CONTOURS,
        "source-layer": generatedContourUrl ? "contours" : "contour",
        minzoom: 12,
        filter: generatedContourUrl ? [">", ["get", "level"], 0] : [">=", ["get", "nth_line"], 5],
        layout: {
          "symbol-placement": "line",
          "text-field": [
            "concat",
            ["to-string", ["get", generatedContourUrl ? "ele" : "height"]],
            " m",
          ],
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

  for (const id of [ELEVATION_TINT, HILLSHADE, CONTOUR_LINES, CONTOUR_LABELS]) {
    if (map.getLayer(id) && map.getLayoutProperty(id, "visibility") === "none") {
      map.setLayoutProperty(id, "visibility", "visible");
    }
  }
  const colors = [
    [
      HILLSHADE,
      "hillshade-shadow-color",
      dark
        ? ["#263443", "#304351", "#263443", "#304351"]
        : ["#687682", "#89947f", "#687682", "#89947f"],
    ],
    [
      HILLSHADE,
      "hillshade-highlight-color",
      dark
        ? ["#78848c", "#74868e", "#78848c", "#74868e"]
        : ["#ffffff", "#f5f4e9", "#ffffff", "#f5f4e9"],
    ],
    [HILLSHADE, "hillshade-accent-color", dark ? "#3e5260" : "#a8b4a2"],
    [ELEVATION_TINT, "color-relief-color", elevationTint],
    [ELEVATION_TINT, "color-relief-opacity", dark ? 0.09 : 0.13],
    [CONTOUR_LINES, "line-color", dark ? "#b4a998" : "#786b60"],
    [CONTOUR_LABELS, "text-color", dark ? "#c7bfb1" : "#74675b"],
    [CONTOUR_LABELS, "text-halo-color", dark ? "#1c2830" : "#f5f2e9"],
  ] as const;
  for (const [id, property, value] of colors) {
    if (!map.getLayer(id)) continue;
    if (JSON.stringify(map.getPaintProperty(id, property)) !== JSON.stringify(value)) {
      map.setPaintProperty(id, property, value);
    }
  }
  if (map.getTerrain()?.source !== DEM) map.setTerrain({ source: DEM, exaggeration: 1 });
}
