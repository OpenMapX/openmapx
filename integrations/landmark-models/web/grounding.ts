import { itemAt } from "@openmapx/core";
import type { MultiPolygon, Polygon, Position } from "geojson";
import { LngLat, type Map as MaplibreMap } from "maplibre-gl";

/** One terrain sample: whether DEM data has loaded there, and the drawn tile's own height. */
export interface TerrainSample {
  state: "loaded" | "loading" | "none";
  /** Elevation from the drawn tile's own DEM data; absent while only a parent's is loaded. */
  drawn?: number;
}

export interface TerrainProbe {
  enabled(): boolean;
  sample(lngLat: [number, number]): TerrainSample;
}

const MAX_FOOTPRINT_SAMPLES = 16;

/**
 * Reads terrain the way grounding needs it. MapLibre answers 0 where no DEM
 * data has loaded and a coarse parent's height where only that has, so a
 * sample counts only when its data is loaded and the drawn tile has its own.
 */
export function mapTerrainProbe(map: MaplibreMap): TerrainProbe {
  return {
    enabled: () => !!map.getTerrain(),
    sample: (lngLat) => {
      const terrain = map.terrain;
      if (!terrain) return { state: "none" };
      const point = LngLat.convert(lngLat);
      const { demState } = terrain.getElevationAndDEMStateForLngLat(
        point,
        Math.floor(map.getZoom()),
      );
      const drawn = terrain.getDrawnElevationForLngLat(point, true);
      return { state: demState, ...(drawn === undefined ? {} : { drawn }) };
    },
  };
}

function footprintPoints(footprint: Polygon | MultiPolygon | undefined): Position[] {
  if (!footprint) return [];
  const rings =
    footprint.type === "Polygon"
      ? [footprint.coordinates[0] ?? []]
      : footprint.coordinates.map((polygon) => polygon[0] ?? []);
  const points = rings.flatMap((ring) => ring.slice(0, -1));
  if (points.length <= MAX_FOOTPRINT_SAMPLES) return points;
  const step = points.length / MAX_FOOTPRINT_SAMPLES;
  return Array.from({ length: MAX_FOOTPRINT_SAMPLES }, (_, i) =>
    itemAt(points, Math.floor(i * step)),
  );
}

/**
 * The ground height a model stands on, or "pending" until every needed sample
 * is exact. Open Landmarks models stand at the anchor's height; Barrelman
 * models at the lowest ground under their footprint. A footprint position
 * without two coordinates is not sampled.
 */
export function groundHeight(
  asset: { anchor: readonly [number, number]; grounding: "anchor" | "footprint-minimum" },
  footprint: Polygon | MultiPolygon | undefined,
  probe: TerrainProbe,
): number | "pending" {
  if (!probe.enabled()) return 0;
  const points: Position[] = [
    [asset.anchor[0], asset.anchor[1]],
    ...(asset.grounding === "footprint-minimum" ? footprintPoints(footprint) : []),
  ];
  let lowest = Infinity;
  for (const [lng, lat] of points) {
    if (lng === undefined || lat === undefined) continue;
    const sample = probe.sample([lng, lat]);
    if (sample.state !== "loaded" || sample.drawn === undefined) return "pending";
    lowest = Math.min(lowest, sample.drawn);
  }
  return lowest;
}
