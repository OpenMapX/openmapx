import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type {
  ExpressionSpecification,
  Map as MapLibreMap,
  RasterDEMSourceSpecification,
} from "maplibre-gl";
import { addLayerWithinBasemap } from "@/integration-api/map/layerStack";
import { ensureUrlTileSource } from "@/integration-api/map/layerStyleUtils";
import { demMapContributors } from "@/integration-api/overlay/demMapContribution";
import {
  addAttributedRasterSource,
  updateRasterAcquisitionContributors,
} from "@/integration-api/overlay/rasterMapContribution";

const DEM = "openmapx-terrain-dem";
const HILLSHADE_DEM = "openmapx-terrain-hillshade-dem";
const CONTOURS = "openmapx-terrain-contours";
const ELEVATION_TINT = "openmapx-terrain-elevation-tint";
const HILLSHADE = "openmapx-terrain-hillshade";
const CONTOUR_LINES = "openmapx-terrain-contour-lines";
const CONTOUR_LABELS = "openmapx-terrain-contour-labels";
const RELIEF_DEM = "openmapx-default-relief-dem";
const RELIEF = "openmapx-default-relief";
const TERRAIN_LAYERS = [ELEVATION_TINT, HILLSHADE, CONTOUR_LINES, CONTOUR_LABELS];

/**
 * `subtle` is the soft mountain shading of the default street map; `full` is
 * the Terrain base with contours, elevation tint and a 3D terrain mesh.
 */
export type TerrainRelief = "off" | "subtle" | "full";

export interface TerrainStyleOptions {
  demUrl: string;
  contoursUrl: string;
  dark: boolean;
  demEncoding?: "mapbox" | "terrarium";
  generatedContourUrl?: string;
  contributors?: readonly Attribution[];
}

type TerrainStyleMap = Pick<
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
>;

function setLayersVisible(map: TerrainStyleMap, ids: readonly string[], visible: boolean): void {
  const visibility = visible ? "visible" : "none";
  for (const id of ids) {
    if (map.getLayer(id) && (map.getLayoutProperty(id, "visibility") ?? "visible") !== visibility) {
      map.setLayoutProperty(id, "visibility", visibility);
    }
  }
}

const contourReceipts = new WeakMap<object, Attribution[]>();
const demSpecifications = new WeakMap<object, string>();
export const TERRAIN_CONTOUR_LAYERS = [CONTOUR_LINES, CONTOUR_LABELS];
const DEM_LAYERS = [
  { layerId: RELIEF, sourceId: RELIEF_DEM },
  { layerId: HILLSHADE, sourceId: HILLSHADE_DEM },
  { layerId: ELEVATION_TINT, sourceId: HILLSHADE_DEM },
];

/** Source-object identity retains the supplier of cached/generated contours. */
export function terrainContourContributors(map: MapLibreMap): Attribution[] {
  const source = map.getSource(CONTOURS);
  return source ? snapshotContributors(contourReceipts.get(source) ?? []) : [];
}

export function terrainDemContributors(map: MapLibreMap): Attribution[] {
  return demMapContributors(map, DEM_LAYERS, DEM);
}

function ensureDemSource(
  map: TerrainStyleMap,
  id: string,
  specification: RasterDEMSourceSpecification,
  contributors: readonly Attribution[],
): void {
  const mounted = map.getSource(id);
  const key = JSON.stringify(specification);
  if (!mounted) {
    addAttributedRasterSource(map, id, specification, contributors);
    const source = map.getSource(id);
    if (source) demSpecifications.set(source, key);
  } else if (demSpecifications.get(mounted) === key) {
    // Configuration changes do not rewrite an already mounted source URL.
    // Update future notices only while they describe that effective supplier.
    updateRasterAcquisitionContributors(map, id, contributors);
  }
}

function reliefColors(dark: boolean) {
  return dark
    ? {
        "hillshade-shadow-color": "rgba(4, 8, 14, 0.6)",
        "hillshade-highlight-color": "rgba(170, 190, 200, 0.14)",
        "hillshade-accent-color": "rgba(4, 8, 14, 0.3)",
      }
    : {
        "hillshade-shadow-color": "rgba(40, 70, 55, 0.55)",
        "hillshade-highlight-color": "rgba(255, 255, 255, 0.5)",
        "hillshade-accent-color": "rgba(40, 70, 55, 0.3)",
      };
}

/**
 * Soft shading that reads mountains without turning the street map into a
 * topographic one: it fades in from zoom 6, peaks around zoom 10–12 and is
 * gone by zoom 14 where streets matter. Capping the DEM at zoom 9 lets closer
 * views overzoom it, which generalises the relief instead of showing every
 * gully.
 */
function syncSubtleRelief(
  map: TerrainStyleMap,
  demUrl: string,
  demEncoding: "mapbox" | "terrarium",
  dark: boolean,
  contributors: readonly Attribution[],
): void {
  ensureDemSource(
    map,
    RELIEF_DEM,
    {
      type: "raster-dem",
      url: demUrl,
      tileSize: 512,
      encoding: demEncoding,
      maxzoom: 9,
    },
    contributors,
  );
  const colors = reliefColors(dark);
  if (!map.getLayer(RELIEF)) {
    addLayerWithinBasemap(
      map,
      {
        id: RELIEF,
        type: "hillshade",
        source: RELIEF_DEM,
        minzoom: 6,
        maxzoom: 14,
        paint: {
          "hillshade-method": "standard",
          "hillshade-exaggeration": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            0,
            8,
            0.15,
            10,
            0.4,
            12,
            0.35,
            13,
            0.18,
            14,
            0,
          ],
          "hillshade-illumination-direction": 315,
          "hillshade-illumination-anchor": "map",
          ...colors,
        },
      },
      "before-water",
    );
  }
  setLayersVisible(map, [RELIEF], true);
  for (const [property, value] of Object.entries(colors) as [keyof typeof colors, string][]) {
    if (map.getPaintProperty(RELIEF, property) !== value) {
      map.setPaintProperty(RELIEF, property, value);
    }
  }
}

/** Keep relief below vector roads and labels, including after a style swap. */
export function syncTerrainStyle(
  map: TerrainStyleMap,
  relief: TerrainRelief,
  {
    demUrl,
    contoursUrl,
    dark,
    demEncoding = "mapbox",
    generatedContourUrl,
    contributors = [],
  }: TerrainStyleOptions,
): void {
  if (relief !== "subtle") setLayersVisible(map, [RELIEF], false);
  if (relief !== "full") {
    if (map.getTerrain()?.source === DEM) map.setTerrain(null);
    setLayersVisible(map, TERRAIN_LAYERS, false);
    if (relief === "subtle") syncSubtleRelief(map, demUrl, demEncoding, dark, contributors);
    return;
  }

  ensureDemSource(
    map,
    DEM,
    {
      type: "raster-dem",
      url: demUrl,
      tileSize: 512,
      encoding: demEncoding,
    },
    contributors,
  );
  // MapLibre renders hillshade more reliably when its DEM source is separate
  // from the source used to displace the 3D terrain mesh.
  ensureDemSource(
    map,
    HILLSHADE_DEM,
    {
      type: "raster-dem",
      url: demUrl,
      tileSize: 512,
      encoding: demEncoding,
    },
    contributors,
  );
  const hasContours = Boolean(generatedContourUrl || contoursUrl);
  if (hasContours) {
    const previousContours = map.getSource(CONTOURS);
    ensureUrlTileSource(
      map,
      CONTOURS,
      generatedContourUrl
        ? { type: "vector", tiles: [generatedContourUrl], maxzoom: 15 }
        : { type: "vector", url: contoursUrl },
    );
    const source = map.getSource(CONTOURS);
    if (!previousContours && source)
      contourReceipts.set(source, snapshotContributors(contributors));
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

  setLayersVisible(map, TERRAIN_LAYERS, true);
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
