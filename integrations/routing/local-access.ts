import type { LngLat, LocalAccessEndpoint, RoutingOptions } from "@openmapx/core";
import { haversineDistance } from "@openmapx/core";

/**
 * Roads closed to all but local access ("Anlieger frei") near a route's ends.
 * The engine closes them to every car; a route may still start or end on one,
 * or pass one to reach a street only reachable through it. These helpers
 * decide, from the closures' lines, how each end of a request is relaxed.
 */

/** An end this close to such a road may snap onto it. */
const SNAP_M = 100;
/** An end this close to such a road may be reachable only through it. */
const REACH_M = 1_000;
/** Access points offered per end, nearest road first. */
const MAX_ACCESS_POINTS = 2;
/** A route counts as using such a road when it runs this long within reach of one. */
const ALONG_M = 20;
const ALONG_WITHIN_M = 15;

/**
 * The point of `line` nearest `p`, its distance in metres, and how far along
 * the line it lies, in metres from its start.
 */
function nearestOnLine(
  p: LngLat,
  line: readonly LngLat[],
): { point: LngLat; metres: number; along: number } {
  let best = { point: line[0] ?? p, metres: Number.POSITIVE_INFINITY, along: 0 };
  const k = Math.cos((p[1] * Math.PI) / 180);
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1] ?? a;
    const dx = (b[0] - a[0]) * k;
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((p[0] - a[0]) * k * dx + (p[1] - a[1]) * dy) / len2));
    const point: LngLat = [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
    const metres = haversineDistance(p, point);
    if (metres < best.metres) best = { point, metres, along: start + haversineDistance(a, point) };
    start += haversineDistance(a, b);
  }
  return best;
}

/** A line's bounding box grown by `metres`: [west, south, east, north]. */
function paddedBox(line: readonly LngLat[], metres: number): [number, number, number, number] {
  const lats = line.map((p) => p[1]);
  const lons = line.map((p) => p[0]);
  const dLat = metres / 111_320;
  const dLon = dLat / Math.max(0.01, Math.cos((Math.max(...lats.map(Math.abs)) * Math.PI) / 180));
  return [
    Math.min(...lons) - dLon,
    Math.min(...lats) - dLat,
    Math.max(...lons) + dLon,
    Math.max(...lats) + dLat,
  ];
}

const round = (v: number) => Math.round(v * 1e7) / 1e7;

function distanceTo(p: LngLat, lines: readonly (readonly LngLat[])[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const line of lines) min = Math.min(min, nearestOnLine(p, line).metres);
  return min;
}

function planEnd(
  end: LngLat,
  local: readonly (readonly LngLat[])[],
  hard: readonly (readonly LngLat[])[],
): LocalAccessEndpoint | undefined {
  const near = local
    .map((line) => nearestOnLine(end, line))
    .filter((n) => n.metres <= REACH_M)
    .sort((a, b) => a.metres - b.metres);
  if (near.length === 0) return undefined;
  return {
    snapOntoClosure: near[0]!.metres <= SNAP_M && distanceTo(end, hard) > SNAP_M,
    accessPoints: near.slice(0, MAX_ACCESS_POINTS).map((n) => n.point),
  };
}

/**
 * How the first and last waypoint are relaxed for the local-access roads
 * `local`; `hard` are the lines of closures no car may use. An end within
 * 100 m of such a road, and not as near a hard closure, may snap onto it; an
 * end within a kilometre is offered the nearest points of up to two of them
 * to reach it through. Intermediate stops are never relaxed.
 */
export function planLocalAccess(
  waypoints: readonly LngLat[],
  local: readonly (readonly LngLat[])[],
  hard: readonly (readonly LngLat[])[],
): RoutingOptions["localAccess"] {
  if (local.length === 0 || waypoints.length < 2) return undefined;
  const origin = planEnd(waypoints[0]!, local, hard);
  const destination = planEnd(waypoints[waypoints.length - 1]!, local, hard);
  if (!origin && !destination) return undefined;
  return { ...(origin ? { origin } : {}), ...(destination ? { destination } : {}) };
}

const endsOf = (waypoints: readonly LngLat[]) =>
  [waypoints[0], waypoints[waypoints.length - 1]].filter((p): p is LngLat => p !== undefined);

/**
 * Whether a road without routing evidence, closed to all but local access,
 * may be excluded: no end of the route lies on it. Excluded geometry has no
 * notion of a route's ends, so such a road stays open only where an end needs
 * it; a street behind it is then reached by the engine's own snapping.
 */
export function clearOfEndpoints(line: readonly LngLat[], waypoints: readonly LngLat[]): boolean {
  return endsOf(waypoints).every((end) => nearestOnLine(end, line).metres > SNAP_M);
}

/** The roads of `lines` within a kilometre of either end of a route. */
export function nearbyLines(waypoints: readonly LngLat[], lines: readonly LngLat[][]): LngLat[][] {
  const ends = endsOf(waypoints);
  return lines.filter((line) => ends.some((end) => nearestOnLine(end, line).metres <= REACH_M));
}

/**
 * Whether `route` drives along one of the local-access roads `local` for 20 m
 * or more: consecutive vertices within 15 m of the same road whose positions
 * along it lie 20 m apart. A route only crossing the road, however dense its
 * vertices at the junction, makes no progress along it.
 */
export function routeUsesLocalAccessRoad(
  route: readonly LngLat[],
  local: readonly (readonly LngLat[])[],
): boolean {
  if (local.length === 0) return false;
  const roads = local.map((line) => ({ line, box: paddedBox(line, ALONG_WITHIN_M) }));
  let run: { road: number; from: number } | undefined;
  for (const p of route) {
    let near: { road: number; along: number } | undefined;
    for (let r = 0; r < roads.length && !near; r++) {
      const { line, box } = roads[r]!;
      if (p[0] < box[0] || p[0] > box[2] || p[1] < box[1] || p[1] > box[3]) continue;
      const hit = nearestOnLine(p, line);
      if (hit.metres <= ALONG_WITHIN_M) near = { road: r, along: hit.along };
    }
    if (!near) {
      run = undefined;
    } else if (run?.road !== near.road) {
      run = { road: near.road, from: near.along };
    } else if (Math.abs(near.along - run.from) >= ALONG_M) {
      return true;
    }
  }
  return false;
}
