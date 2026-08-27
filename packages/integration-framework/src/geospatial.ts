export type Wgs84Point = [longitude: number, latitude: number];
export type Wgs84BoundingBox = [west: number, south: number, east: number, north: number];

export interface PointLimits {
  /** Useful for calculations whose longitude scale becomes singular at the poles. */
  maxAbsLatitude?: number;
}

export interface BoundingBoxLimits {
  maxLatitudeSpan: number;
  maxLongitudeSpan: number;
  /** Square degrees; deliberately a cheap request-cost guard, not a surface-area measurement. */
  maxArea: number;
}

export interface PointListLimits extends PointLimits {
  min: number;
  max: number;
}

export interface RadiusLimits {
  defaultValue: number;
  max: number;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseWgs84Point(
  longitude: unknown,
  latitude: unknown,
  limits: PointLimits = {},
): Wgs84Point | null {
  const lng = finiteNumber(longitude);
  const lat = finiteNumber(latitude);
  const maxAbsLatitude = limits.maxAbsLatitude ?? 90;
  if (
    lng === null ||
    lat === null ||
    lng < -180 ||
    lng > 180 ||
    lat < -maxAbsLatitude ||
    lat > maxAbsLatitude
  ) {
    return null;
  }
  return [lng, lat];
}

export function parseWgs84BoundingBox(
  values: { west: unknown; south: unknown; east: unknown; north: unknown },
  limits: BoundingBoxLimits,
): Wgs84BoundingBox | null {
  const southwest = parseWgs84Point(values.west, values.south);
  const northeast = parseWgs84Point(values.east, values.north);
  if (!southwest || !northeast) return null;
  const [west, south] = southwest;
  const [east, north] = northeast;
  const longitudeSpan = east - west;
  const latitudeSpan = north - south;
  if (
    longitudeSpan <= 0 ||
    latitudeSpan <= 0 ||
    longitudeSpan > limits.maxLongitudeSpan ||
    latitudeSpan > limits.maxLatitudeSpan ||
    longitudeSpan * latitudeSpan > limits.maxArea
  ) {
    return null;
  }
  return [west, south, east, north];
}

export function parsePositiveRadius(value: unknown, limits: RadiusLimits): number | null {
  const parsed = value === undefined ? limits.defaultValue : finiteNumber(value);
  if (parsed === null || parsed <= 0 || parsed > limits.max) return null;
  return parsed;
}

export function parseWgs84PointList(value: unknown, limits: PointListLimits): Wgs84Point[] | null {
  if (!Array.isArray(value) || value.length < limits.min || value.length > limits.max) return null;
  const points: Wgs84Point[] = [];
  for (const candidate of value) {
    if (!Array.isArray(candidate) || candidate.length !== 2) return null;
    const point = parseWgs84Point(candidate[0], candidate[1], limits);
    if (!point) return null;
    points.push(point);
  }
  return points;
}

function wrapLongitude(value: number): number {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  // Keep +180 for an eastern edge that sits exactly on the antimeridian.
  return wrapped === -180 && value > 0 ? 180 : wrapped;
}

/**
 * Viewport-driven boxes (raw `map.getBounds()`) legitimately exceed the
 * request-cost limits at low zoom, carry world-copy longitudes outside ±180,
 * or cross the antimeridian. Clamp them into a valid, bounded box around the
 * viewport centre instead of rejecting the request; only non-finite input is
 * an error.
 */
export function clampViewportBoundingBox(
  values: { west: unknown; south: unknown; east: unknown; north: unknown },
  limits: BoundingBoxLimits,
): Wgs84BoundingBox | null {
  const rawWest = finiteNumber(values.west);
  const rawSouth = finiteNumber(values.south);
  const rawEast = finiteNumber(values.east);
  const rawNorth = finiteNumber(values.north);
  if (rawWest === null || rawSouth === null || rawEast === null || rawNorth === null) return null;

  let south = Math.max(-90, Math.min(rawSouth, rawNorth));
  let north = Math.min(90, Math.max(rawSouth, rawNorth));
  let west: number;
  let east: number;
  if (rawEast - rawWest >= 360) {
    west = -180;
    east = 180;
  } else {
    west = wrapLongitude(Math.min(rawWest, rawEast));
    east = wrapLongitude(Math.max(rawWest, rawEast));
    if (west > east) {
      // Antimeridian crossing cannot be expressed as one west<east box; keep
      // the wider side so the dominant part of the viewport is still served.
      if (180 - west >= east + 180) east = 180;
      else west = -180;
    }
  }

  const centreLng = (west + east) / 2;
  const centreLat = (south + north) / 2;
  let lngSpan = Math.min(east - west, limits.maxLongitudeSpan);
  let latSpan = Math.min(north - south, limits.maxLatitudeSpan);
  if (lngSpan * latSpan > limits.maxArea) {
    const scale = Math.sqrt(limits.maxArea / (lngSpan * latSpan));
    lngSpan *= scale;
    latSpan *= scale;
  }
  west = Math.max(-180, centreLng - lngSpan / 2);
  east = Math.min(180, centreLng + lngSpan / 2);
  south = Math.max(-90, centreLat - latSpan / 2);
  north = Math.min(90, centreLat + latSpan / 2);
  if (east - west <= 0 || north - south <= 0) return null;
  return [west, south, east, north];
}
