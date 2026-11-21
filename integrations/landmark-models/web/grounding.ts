import { itemAt, type TerrainProbe } from "@openmapx/core";
import type { MultiPolygon, Polygon, Position } from "geojson";

const MAX_FOOTPRINT_SAMPLES = 16;

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
