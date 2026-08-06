import type { BoundingBox, LngLat } from "../types/geometry";
import { cumulativeDistances, positionAt } from "./deadReckon";
import { asRouteMatcher, type RouteMatcherInput, snapPreparedRoute } from "./routeMatcher";

/** A POI projected onto the active route, with an estimated detour. */
export interface AlongRoutePoi<T> {
  place: T;
  /** Arc-length of the nearest point on the route, metres from the start. */
  alongMeters: number;
  /** Perpendicular distance from the route, metres. */
  deviationMeters: number;
  /** Estimated extra distance to detour to the POI and rejoin, metres (≈ 2 × deviation). */
  detourMeters: number;
  /** Estimated extra travel time for the detour, seconds. */
  detourSeconds: number;
}

export interface AlongRouteOptions {
  /** Max perpendicular distance (m) from the route to include a POI. */
  corridorMeters?: number;
  /** Only include POIs ahead and within this distance along the route. */
  lookaheadMeters?: number;
  /** Speed (m/s) used to turn the detour distance into a time estimate. */
  speedMps?: number;
}

const DEFAULT_CORRIDOR_M = 1200;
const DEFAULT_LOOKAHEAD_M = 25_000;
const DEFAULT_SPEED_MPS = 14;

/**
 * Project POIs onto the active route and keep those that are ahead of the
 * current position, within the corridor, and within the look-ahead window;
 * each is returned with an estimated detour (leave the route + rejoin ≈ twice
 * the perpendicular deviation). Sorted by distance along the route. Pure.
 *
 * `route` is the active route's prepared matcher, so a results refresh projects
 * the whole POI set against one index. Passing the bare geometry prepares it
 * once here, never once per POI.
 */
export function poiAlongRoute<T extends { coordinates: LngLat }>(
  places: T[],
  route: RouteMatcherInput,
  currentAlongMeters: number,
  opts: AlongRouteOptions = {},
): AlongRoutePoi<T>[] {
  const matcher = asRouteMatcher(route);
  if (matcher.geometry.length < 2) return [];
  const corridor = opts.corridorMeters ?? DEFAULT_CORRIDOR_M;
  const lookahead = opts.lookaheadMeters ?? DEFAULT_LOOKAHEAD_M;
  const speed = opts.speedMps && opts.speedMps > 0 ? opts.speedMps : DEFAULT_SPEED_MPS;

  const out: AlongRoutePoi<T>[] = [];
  for (const place of places) {
    const snap = snapPreparedRoute(matcher, place.coordinates);
    if (snap.deviationMeters > corridor) continue;
    const ahead = snap.alongMeters - currentAlongMeters;
    if (ahead <= 0 || ahead > lookahead) continue;
    const detourMeters = 2 * snap.deviationMeters;
    out.push({
      place,
      alongMeters: snap.alongMeters,
      deviationMeters: snap.deviationMeters,
      detourMeters,
      detourSeconds: detourMeters / speed,
    });
  }
  out.sort((a, b) => a.alongMeters - b.alongMeters);
  return out;
}

/**
 * Bounding box of the route ahead of the current position, up to
 * `lookaheadMeters`, for a corridor POI query — the box of all route vertices
 * whose along-distance falls in `[fromAlongMeters, fromAlongMeters + lookahead]`.
 * Returns null when nothing falls in the window. Pure.
 */
export function routeAheadBounds(
  geometry: LngLat[],
  fromAlongMeters: number,
  lookaheadMeters = DEFAULT_LOOKAHEAD_M,
): BoundingBox | null {
  if (geometry.length < 2) return null;
  const cum = cumulativeDistances(geometry);
  const end = fromAlongMeters + lookaheadMeters;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let any = false;
  for (let i = 0; i < geometry.length; i++) {
    if (cum[i] < fromAlongMeters || cum[i] > end) continue;
    const [lng, lat] = geometry[i];
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    any = true;
  }
  return any ? { south, west, north, east } : null;
}

/** Metres of latitude per degree, a WGS84-near-enough constant. */
const METERS_PER_LAT_DEGREE = 110_540;
/** Metres of longitude per degree at the equator; shrinks by cos(latitude) elsewhere. */
const METERS_PER_LON_DEGREE_AT_EQUATOR = 111_320;
/**
 * Latitude past which longitude padding is computed as if the corridor were
 * at this latitude instead. `cos(latitude)` is what turns a metre of
 * longitude into degrees, and it approaches 0 at the poles; without a floor,
 * padding a box that touches ~90° would divide by ~0 and produce an infinite
 * or NaN east/west bound. Capping the effective latitude keeps the padding
 * finite (and generously wide) instead.
 */
const MAX_PAD_LATITUDE_DEG = 85;
const MIN_COS_LATITUDE = Math.cos((MAX_PAD_LATITUDE_DEG * Math.PI) / 180);

function metersToLatDegrees(meters: number): number {
  return meters / METERS_PER_LAT_DEGREE;
}

function metersToLonDegrees(meters: number, latDeg: number): number {
  const cappedLat = Math.min(Math.abs(latDeg), MAX_PAD_LATITUDE_DEG);
  const cosLat = Math.max(Math.cos((cappedLat * Math.PI) / 180), MIN_COS_LATITUDE);
  return meters / (METERS_PER_LON_DEGREE_AT_EQUATOR * cosLat);
}

/** `lng`, shifted by ±360 from `previous` if needed so the two are never more
 * than 180° apart — turns a route's raw (wrapped) coordinates into a
 * continuous sequence a dateline crossing can't fool a min/max scan on. */
function unwrapLongitude(lng: number, previous: number): number {
  let unwrapped = lng;
  while (unwrapped - previous > 180) unwrapped -= 360;
  while (unwrapped - previous < -180) unwrapped += 360;
  return unwrapped;
}

/** `lng`, folded back into (-180, 180]. */
function normalizeLongitude(lng: number): number {
  let normalized = lng;
  while (normalized > 180) normalized -= 360;
  while (normalized <= -180) normalized += 360;
  return normalized;
}

/**
 * Split a continuous (possibly antimeridian-straddling) longitude span,
 * `west`..`east` in the same unwrapped space {@link unwrapLongitude} produces
 * (so `east >= west`, and either may be outside [-180, 180]), into one or two
 * non-wrapping [-180, 180] spans that together cover it.
 */
function splitAntimeridian(west: number, east: number): Array<[number, number]> {
  // Shift the whole span by whatever multiple of 360° brings `west` into
  // range; `east` moves the same amount, so the span's width — and thus
  // whether it still crosses 180° on the other side — is unchanged.
  const shift = Math.round((normalizeLongitude(west) - west) / 360) * 360;
  const shiftedWest = west + shift;
  const shiftedEast = east + shift;
  if (shiftedEast <= 180) return [[shiftedWest, shiftedEast]];
  const boxes: Array<[number, number]> = [[shiftedWest, 180]];
  const wrappedEast = shiftedEast - 360;
  if (wrappedEast > -180) boxes.push([-180, wrappedEast]);
  return boxes;
}

/** Unwrapped-longitude, plain-latitude extent of an ordered list of points. */
function boundsFromPoints(points: readonly LngLat[]): {
  west: number;
  east: number;
  south: number;
  north: number;
} {
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let previousLng = points[0][0];
  for (const [lng, lat] of points) {
    const unwrapped = unwrapLongitude(lng, previousLng);
    previousLng = unwrapped;
    if (unwrapped < west) west = unwrapped;
    if (unwrapped > east) east = unwrapped;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, east, south, north };
}

/** Physical corridor padding applied to {@link paddedRouteAheadBounds} by default. */
export const DEFAULT_CORRIDOR_PAD_METERS = 250;

/**
 * Bounding box (or, across the antimeridian, two) of the route ahead of the
 * current position, from `fromAlongMeters` through `fromAlongMeters +
 * lookaheadMeters`, padded by `padMeters` on every side. Unlike
 * {@link routeAheadBounds}, the window's start and end are interpolated
 * exactly rather than snapped to the nearest existing vertex, so a single
 * edge spanning (or exceeding) the whole window still produces a correct box
 * instead of an empty one, and features just off the line stay inside the
 * padded corridor rather than falling just outside a bbox drawn tight to the
 * route. Returns `null` only for geometry too short or too broken to bound at
 * all — a window entirely past the route's end still returns a (degenerate,
 * padded) box around its final point, since that is where the route ahead
 * actually is.
 */
export function paddedRouteAheadBounds(
  geometry: LngLat[],
  fromAlongMeters: number,
  lookaheadMeters: number,
  padMeters = DEFAULT_CORRIDOR_PAD_METERS,
): BoundingBox[] | null {
  if (geometry.length < 2) return null;
  for (const [lng, lat] of geometry) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  }
  if (
    !Number.isFinite(fromAlongMeters) ||
    !Number.isFinite(lookaheadMeters) ||
    !Number.isFinite(padMeters)
  ) {
    return null;
  }

  const cum = cumulativeDistances(geometry);
  const end = fromAlongMeters + Math.max(lookaheadMeters, 0);

  const points: LngLat[] = [positionAt(geometry, cum, fromAlongMeters).point];
  for (let i = 0; i < geometry.length; i++) {
    if (cum[i] >= fromAlongMeters && cum[i] <= end) points.push(geometry[i]);
  }
  points.push(positionAt(geometry, cum, end).point);

  const { west, east, south, north } = boundsFromPoints(points);
  const worstLat = Math.max(Math.abs(south), Math.abs(north));
  const latPad = metersToLatDegrees(padMeters);
  const lonPad = metersToLonDegrees(padMeters, worstLat);

  const paddedSouth = Math.max(-90, south - latPad);
  const paddedNorth = Math.min(90, north + latPad);

  return splitAntimeridian(west - lonPad, east + lonPad).map(([boxWest, boxEast]) => ({
    west: boxWest,
    east: boxEast,
    south: paddedSouth,
    north: paddedNorth,
  }));
}

/**
 * Route progress rounded down to a 5 km bucket, so ordinary GPS noise moving
 * the reported along-route position back and forth by a few metres can never
 * change a request's identity. Pair with {@link progressBucketStartMeters} to
 * query a window starting at the bucket boundary — callers decide how far
 * past that to look ahead, since baking a fixed lookahead in here would
 * silently cap it for every caller.
 */
export const PROGRESS_BUCKET_METERS = 5_000;

/** The stable progress bucket `alongMeters` falls in. */
export function progressBucket(alongMeters: number): number {
  return Math.floor(alongMeters / PROGRESS_BUCKET_METERS);
}

/** The along-route distance (metres) a progress bucket starts at. */
export function progressBucketStartMeters(bucket: number): number {
  return bucket * PROGRESS_BUCKET_METERS;
}
