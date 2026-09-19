import type { LngLat } from "@openmapx/core";

/**
 * Shared query parsing and heading filter for the street-level-imagery
 * `/search` routes. Helpers only — this module registers no routes.
 */

/** Radius bounds of the `/search` route, metres. */
const MIN_RADIUS_M = 1;
const MAX_RADIUS_M = 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Default heading tolerance when the caller sends none. */
const DEFAULT_HEADING_TOLERANCE_DEG = 30;

export interface ParsedStreetLevelSearch {
  lngLat: LngLat;
  radiusM: number;
  heading?: number;
  headingToleranceDeg: number;
  capturedAfter?: string;
  lookingAt?: LngLat;
  limit: number;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function wgs84(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n === null || n < -180 || n > 180) return null;
  return n;
}

/**
 * Parse and validate the `/search` route's query string. Returns null for any
 * malformed field — the route turns that into a 400.
 */
export function parseStreetLevelSearchQuery(
  query: Record<string, unknown>,
): ParsedStreetLevelSearch | null {
  const lng = wgs84(query.lng);
  const lat = finiteNumber(query.lat);
  if (lng === null || lat === null || lat < -90 || lat > 90) return null;
  const radiusM = finiteNumber(query.radius);
  if (radiusM === null || radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) return null;
  const heading = finiteNumber(query.heading) ?? undefined;
  if (heading !== undefined && (heading < 0 || heading >= 360)) return null;
  const headingTolerance = finiteNumber(query.headingTolerance) ?? DEFAULT_HEADING_TOLERANCE_DEG;
  if (headingTolerance <= 0 || headingTolerance > 180) return null;
  const limitRaw = finiteNumber(query.limit) ?? DEFAULT_LIMIT;
  if (limitRaw < 1 || limitRaw > MAX_LIMIT) return null;
  const lookAtLng = wgs84(query.lookAtLng);
  const lookAtLat = finiteNumber(query.lookAtLat);
  const lookingAt =
    lookAtLng !== null && lookAtLat !== null && lookAtLat >= -90 && lookAtLat <= 90
      ? ([lookAtLng, lookAtLat] as LngLat)
      : undefined;
  const after = typeof query.after === "string" && query.after.length > 0 ? query.after : undefined;
  return {
    lngLat: [lng, lat],
    radiusM,
    ...(heading !== undefined ? { heading } : {}),
    headingToleranceDeg: headingTolerance,
    ...(after ? { capturedAfter: after } : {}),
    ...(lookingAt ? { lookingAt } : {}),
    limit: Math.round(limitRaw),
  };
}

/** Shortest signed angle between two bearings, degrees. */
function angularDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/**
 * Keep only images whose heading sits within the tolerance of the target.
 * Images without a heading are dropped — an unknown direction cannot back a
 * "approach view" claim. No filter requested: everything passes.
 */
export function filterImagesByHeading(
  images: { heading?: number }[],
  heading: number | undefined,
  toleranceDeg: number,
): { heading?: number }[] {
  if (heading === undefined) return images;
  return images.filter(
    (image) =>
      image.heading !== undefined && angularDifference(image.heading, heading) <= toleranceDeg,
  );
}
