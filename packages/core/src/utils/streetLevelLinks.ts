import type { LngLat } from "../types/geometry";
import type { StreetLevelLink } from "../types/streetLevel";

/**
 * Six fixed compass sectors. Matching the reference Panoramax viewer keeps
 * arrow placement consistent with the imagery people already know, and six
 * buckets is dense enough for junctions without crowding the sphere.
 */
export type DirectionSector = "N" | "ENE" | "ESE" | "S" | "WSW" | "WNW";

export interface StreetLevelArrow extends StreetLevelLink {
  sector: DirectionSector;
  bearing: number;
}

/**
 * Planar bearing in degrees, -180..180, north = 0, east positive.
 *
 * Longitude deltas are scaled by cos(latitude); without that correction a
 * neighbour due north-east reads as a much more easterly bearing the further
 * from the equator you get, which visibly rotates the arrows in Nordic cities.
 * This is a deliberate refinement over the upstream implementation.
 */
export function bearingDegrees(from: LngLat, to: LngLat): number {
  const latRadians = (from[1] * Math.PI) / 180;
  const deltaLng = (to[0] - from[0]) * Math.cos(latRadians);
  const deltaLat = to[1] - from[1];
  return (Math.atan2(deltaLng, deltaLat) * 180) / Math.PI;
}

export function directionSector(bearing: number): DirectionSector {
  const absolute = Math.abs(bearing);
  if (absolute < 30) return "N";
  if (absolute >= 150) return "S";
  if (bearing >= 30 && bearing < 90) return "ENE";
  if (bearing >= 90 && bearing < 150) return "ESE";
  if (bearing <= -30 && bearing > -90) return "WNW";
  return "WSW";
}

function squaredDistance(a: LngLat, b: LngLat): number {
  const latRadians = (a[1] * Math.PI) / 180;
  const deltaLng = (b[0] - a[0]) * Math.cos(latRadians);
  const deltaLat = b[1] - a[1];
  return deltaLng * deltaLng + deltaLat * deltaLat;
}

function captureDay(link: StreetLevelLink): string | null {
  return link.capturedAt ? (link.capturedAt.split("T")[0] ?? null) : null;
}

/**
 * Rank two candidates for the same sector. Lower sorts first.
 * Sequence continuations always win; otherwise same-day ties break on
 * proximity and cross-day ties break on recency.
 */
function compareCandidates(origin: LngLat, a: StreetLevelLink, b: StreetLevelLink): number {
  const aIsSequence = a.rel !== "related";
  const bIsSequence = b.rel !== "related";
  if (aIsSequence !== bIsSequence) return aIsSequence ? -1 : 1;

  const dayA = captureDay(a);
  const dayB = captureDay(b);
  if (dayA && dayB && dayA !== dayB) return dayA > dayB ? -1 : 1;

  return squaredDistance(origin, a.lngLat) - squaredDistance(origin, b.lngLat);
}

/**
 * Reduce raw neighbours to at most one arrow per compass sector.
 * Providers that expose no cross-sequence neighbours simply yield fewer
 * arrows — the interaction stays identical.
 */
export function selectArrowLinks(origin: LngLat, links: StreetLevelLink[]): StreetLevelArrow[] {
  const bySector = new Map<DirectionSector, StreetLevelArrow>();

  for (const link of links) {
    if (link.lngLat[0] === origin[0] && link.lngLat[1] === origin[1]) continue;

    const bearing = bearingDegrees(origin, link.lngLat);
    const sector = directionSector(bearing);
    const incumbent = bySector.get(sector);

    if (!incumbent || compareCandidates(origin, link, incumbent) < 0) {
      bySector.set(sector, { ...link, sector, bearing });
    }
  }

  return Array.from(bySector.values());
}
