import type { MatchResult } from "@integrations/routing/types";
import type { LngLat } from "../types/geometry";
import { cumulativeDistances } from "./deadReckon";

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

export interface GeometryWindow {
  /** The slice to map-match (≤ maxPoints points). */
  trace: LngLat[];
  /** Start index for the next window (overlaps this window's last point). */
  nextStart: number;
  /** True when this window reaches the end of the geometry. */
  done: boolean;
  /** Absolute along-route distance (metres) at the window's far edge. */
  endMeters: number;
}

/**
 * Slice `geometry` into a map-matchable window of at most `maxPoints` points,
 * starting at `startIndex`. Windows overlap by one point so a signal on a cut
 * isn't dropped. `endMeters` is the cumulative geometric distance from the
 * route start to the window's last point — the hook fetches the next window
 * once the driver nears it. Pass `cum` (a pre-computed `cumulativeDistances(geometry)`)
 * to avoid the O(N) recompute on repeated window advances.
 */
export function windowGeometry(
  geometry: LngLat[],
  startIndex: number,
  maxPoints: number,
  cum?: number[],
): GeometryWindow {
  if (geometry.length < 2 || startIndex >= geometry.length - 1) {
    return { trace: [], nextStart: geometry.length, done: true, endMeters: 0 };
  }
  const end = Math.min(startIndex + maxPoints, geometry.length);
  const trace = geometry.slice(startIndex, end);
  const done = end >= geometry.length;
  // Overlap by one point unless we've reached the end.
  const nextStart = done ? geometry.length : end - 1;
  // Cumulative distances may be passed in to avoid recomputing the full-route
  // O(N) walk on every window advance.
  const distances = cum ?? cumulativeDistances(geometry);
  const endMeters = distances[end - 1];
  return { trace, nextStart, done, endMeters };
}
