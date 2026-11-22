import type { LngLat } from "../types/geometry";
import type { MatchResult } from "../types/routing";
import { cumulativeDistances, distanceAtVertex } from "./deadReckon";

/**
 * Dedup key for a traffic-signal coordinate, rounded to ~1m (5 decimal places).
 * Overlapping map-match windows snap the same shared node to marginally
 * different floats, so an exact-float key would draw two icons at one signal;
 * rounding merges them while keeping genuinely-distinct signals (tens of metres
 * apart) separate.
 */
export function signalCoordKey(coord: LngLat): string {
  return `${coord[0].toFixed(5)},${coord[1].toFixed(5)}`;
}

/**
 * Pull traffic-signal coordinates out of a Valhalla map-match result. A signal
 * is an edge whose END node is flagged `endNodeTrafficSignal`; its position is
 * the matched-shape point at `endShapeIndex`. Coordinates are deduped because
 * consecutive edges can share the same end node.
 */
export function extractTrafficSignals(match: MatchResult): LngLat[] {
  const out: LngLat[] = [];
  const seen = new Set<string>();
  for (const edge of match.edges ?? []) {
    if (!edge.endNodeTrafficSignal) continue;
    const coord = match.geometry[edge.endShapeIndex];
    if (!coord) continue;
    const key = signalCoordKey(coord);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([coord[0], coord[1]]);
  }
  return out;
}

/** A signal further than this from the route is on another road. */
const SIGNAL_ON_ROUTE_M = 15;

/**
 * Along-route distances of the signals one match window found, for voice
 * references ("At the second traffic light"). Each signal is projected onto the
 * nearest route segment between vertices `fromIndex` and `toIndex` and dropped
 * when more than 15 m off. Sorted in route order.
 */
export function signalAlongDistances(
  signals: LngLat[],
  geometry: LngLat[],
  cum: number[],
  fromIndex: number,
  toIndex: number,
): number[] {
  const last = Math.min(toIndex, geometry.length - 1);
  const along: number[] = [];
  for (const signal of signals) {
    const metresPerDegLat = 111_320;
    const metresPerDegLon = metresPerDegLat * Math.cos((signal[1] * Math.PI) / 180);
    // Local metres relative to the signal, so the signal sits at the origin.
    const xy = (point: LngLat): [number, number] => [
      (point[0] - signal[0]) * metresPerDegLon,
      (point[1] - signal[1]) * metresPerDegLat,
    ];
    let best: { distance: number; along: number } | null = null;
    for (let i = Math.max(0, fromIndex); i < last; i++) {
      const a = geometry[i];
      const b = geometry[i + 1];
      if (!a || !b) continue;
      const [ax, ay] = xy(a);
      const [bx, by] = xy(b);
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
      const distance = Math.hypot(ax + t * dx, ay + t * dy);
      if (best && distance >= best.distance) continue;
      const start = distanceAtVertex(cum, i);
      best = { distance, along: start + t * (distanceAtVertex(cum, i + 1) - start) };
    }
    if (best && best.distance <= SIGNAL_ON_ROUTE_M) along.push(best.along);
  }
  return along.sort((x, y) => x - y);
}

export interface GeometryWindow {
  /** The slice to map-match (≤ maxPoints points, bounded by distance when supplied). */
  trace: LngLat[];
  /** Start index for the next window (overlaps this window's last point). */
  nextStart: number;
  /** True when this window reaches the end of the geometry. */
  done: boolean;
  /** Absolute along-route distance (metres) at the window's far edge. */
  endMeters: number;
}

/**
 * Slice `geometry` into a map-matchable window of at most `maxPoints` points
 * and `maxMeters` along-route metres, starting at `startIndex`. Always retain
 * two points to advance even if one sparse segment exceeds the distance budget.
 * Windows overlap by one point so a signal on a cut isn't dropped. `endMeters`
 * is the cumulative distance from the route start to the window's last point —
 * the hook fetches the next window once the driver nears it. Pass `cum` (a
 * pre-computed `cumulativeDistances(geometry)`) to avoid the O(N) recompute on
 * repeated window advances.
 */
export function windowGeometry(
  geometry: LngLat[],
  startIndex: number,
  maxPoints: number,
  cum?: number[],
  maxMeters = Number.POSITIVE_INFINITY,
): GeometryWindow {
  if (geometry.length < 2 || startIndex >= geometry.length - 1) {
    return { trace: [], nextStart: geometry.length, done: true, endMeters: 0 };
  }
  const distances = cum ?? cumulativeDistances(geometry);
  let end = Math.min(startIndex + maxPoints, geometry.length);
  const startMeters = distanceAtVertex(distances, startIndex);
  while (end > startIndex + 2 && distanceAtVertex(distances, end - 1) - startMeters > maxMeters) {
    end--;
  }
  const trace = geometry.slice(startIndex, end);
  const done = end >= geometry.length;
  // Overlap by one point unless we've reached the end.
  const nextStart = done ? geometry.length : end - 1;
  const endMeters = distanceAtVertex(distances, end - 1);
  return { trace, nextStart, done, endMeters };
}
