import type { LngLat } from "../types/geometry";
import type { TravelMode } from "../types/routing";
import { bearingBetween } from "./bearing";
import { distanceAtVertex, positionAt } from "./deadReckon";

/** How much route the arrow shows before / after the maneuver point. */
export interface ManeuverArrowSpans {
  before: number;
  after: number;
}

const MODE_SPANS: Record<string, ManeuverArrowSpans> = {
  driving: { before: 60, after: 40 },
  motorcycle: { before: 60, after: 40 },
  walking: { before: 30, after: 20 },
  cycling: { before: 30, after: 20 },
};

/** A route must be at least this long for an arrow to make sense on it. */
const MIN_ROUTE_METERS = 10;

/** Spans for the ground travel mode: motorised modes show more road. */
export function maneuverArrowSpans(mode: TravelMode): ManeuverArrowSpans {
  return MODE_SPANS[mode] ?? { before: 30, after: 20 };
}

/**
 * The polyline between two along-route distances: interpolated endpoints plus
 * every route vertex strictly between them.
 */
function sliceBetween(
  geometry: LngLat[],
  cum: number[],
  fromMeters: number,
  toMeters: number,
): LngLat[] {
  const start = positionAt(geometry, cum, fromMeters).point;
  const points: LngLat[] = [start];
  for (const [i, vertex] of geometry.entries()) {
    if (i === 0) continue;
    if (i === geometry.length - 1) break;
    const along = distanceAtVertex(cum, i);
    if (along <= fromMeters) continue;
    if (along >= toMeters) break;
    points.push(vertex);
  }
  const end = positionAt(geometry, cum, toMeters).point;
  const last = points.at(-1) ?? start;
  if (last[0] !== end[0] || last[1] !== end[1]) points.push(end);
  return points;
}

/**
 * The route-following arrow through a maneuver point: the vertices between
 * `spans.before` metres upstream and `spans.after` metres downstream, clamped
 * to the route ends. `null` when the route is too short to carry an arrow.
 */
export function maneuverArrowLine(
  geometry: LngLat[],
  cum: number[],
  alongMeters: number,
  spans: ManeuverArrowSpans,
): LngLat[] | null {
  const total = distanceAtVertex(cum, cum.length - 1);
  if (total < MIN_ROUTE_METERS) return null;
  const from = Math.max(alongMeters - spans.before, 0);
  const to = Math.min(alongMeters + spans.after, total);
  const line = sliceBetween(geometry, cum, from, to);
  return line.length >= 2 ? line : null;
}

/** Bearing (degrees from north) of the arrow's last segment — the arrowhead's rotation. */
export function maneuverArrowTipBearing(line: LngLat[]): number {
  const from = line.at(-2);
  const to = line.at(-1);
  // An arrow line always has two points; without them there is no direction to point in.
  if (!from || !to) return 0;
  return bearingBetween(from, to);
}
