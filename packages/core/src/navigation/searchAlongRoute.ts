import type { BoundingBox, LngLat } from "../types/geometry";
import { cumulativeDistances } from "./deadReckon";
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
