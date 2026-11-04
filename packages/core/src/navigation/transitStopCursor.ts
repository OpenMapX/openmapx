import { haversineDistance } from "../utils/coordinates";
import { snapPreparedRoute } from "./routeMatcher";
import type { PreparedTransitLeg } from "./transitProgress";
import type { FixInput } from "./types";
import { projectWaypointAfter, resolveWaypointOccurrences } from "./waypointOccurrences";

type Stop = { lat: number; lng: number };
const indexes = new WeakMap<object, WeakMap<object, number[]>>();
/** Project occurrences onto progressively later portions of the line, preserving loop order. */
function orderedAlong(stops: Stop[], leg: PreparedTransitLeg): number[] {
  let byStops = indexes.get(leg);
  if (!byStops) {
    byStops = new WeakMap();
    indexes.set(leg, byStops);
  }
  const cached = byStops.get(stops);
  if (cached) return cached;
  const result = [
    0,
    ...resolveWaypointOccurrences(
      leg.matcher,
      stops.map((stop) => [stop.lng, stop.lat]),
    ).map((stop) => stop.alongMeters),
  ];
  byStops.set(stops, result);
  return result;
}
export interface TransitStopTracking {
  alongTimestampMs?: number;
  candidateAlongMeters?: number;
  candidateTimestampMs?: number;
}
export function advanceTransitStopCursor(
  stops: Stop[],
  leg: PreparedTransitLeg | null | undefined,
  fix: FixInput,
  previous: FixInput | undefined,
  cursor: number,
  alongMeters: number,
  tracking: TransitStopTracking = {},
): { cursor: number; alongMeters: number; trusted: boolean; tracking?: TransitStopTracking } {
  if (stops.length < 2) return { cursor, alongMeters, trusted: false };
  const current = Math.min(Math.max(1, cursor), stops.length - 1);
  if (!leg) {
    // Without a shape, require visiting the next occurrence before moving past it.
    const target = stops[current];
    const near =
      haversineDistance(fix.coords, [target.lng, target.lat]) <= 35 + Math.min(fix.accuracy, 20);
    return {
      cursor: near ? Math.min(current + 1, stops.length - 1) : current,
      alongMeters,
      trusted: near,
    };
  }
  const nearest = snapPreparedRoute(leg.matcher, fix.coords);
  const snap =
    nearest.alongMeters < alongMeters - 50
      ? projectWaypointAfter(leg.matcher, fix.coords, Math.max(0, alongMeters - 50))
      : nearest;
  const movementBudget = (since: number) =>
    Math.max(150, Math.min(Math.max(0, (fix.timestampMs - since) / 1000), 1800) * 90);
  const rawPlausible =
    !previous ||
    haversineDistance(previous.coords, fix.coords) <= movementBudget(previous.timestampMs);
  const inCorridor = snap.deviationMeters <= 50 + Math.min(fix.accuracy, 25);
  const forward = snap.alongMeters >= alongMeters - 50;
  // The first aboard fix anchors the ride, even when boarding was confirmed late.
  // Later progress uses time since trusted progress, rather than time since a rejected fix.
  const plausible =
    tracking.alongTimestampMs === undefined ||
    (rawPlausible && snap.alongMeters - alongMeters <= movementBudget(tracking.alongTimestampMs));
  const consistentCandidate =
    tracking.candidateAlongMeters !== undefined &&
    tracking.candidateTimestampMs !== undefined &&
    fix.timestampMs - tracking.candidateTimestampMs <= 30000 &&
    rawPlausible &&
    Math.abs(snap.alongMeters - tracking.candidateAlongMeters) <=
      movementBudget(tracking.candidateTimestampMs);
  if (!inCorridor || !forward || (!plausible && !consistentCandidate)) {
    // A single jump cannot advance stops; a second consistent corridor fix can
    // recover after a detour, an inaccurate shape, or a late-loaded stop capture.
    const candidate =
      inCorridor && forward
        ? {
            ...tracking,
            candidateAlongMeters: snap.alongMeters,
            candidateTimestampMs: fix.timestampMs,
          }
        : { alongTimestampMs: tracking.alongTimestampMs };
    const near = stops.findIndex(
      (stop, i) =>
        i >= current &&
        i <= current + 2 &&
        haversineDistance(fix.coords, [stop.lng, stop.lat]) <= 35 + Math.min(fix.accuracy, 20),
    );
    return {
      cursor: near >= current && rawPlausible ? Math.min(near + 1, stops.length - 1) : current,
      alongMeters,
      trusted: near >= current && rawPlausible,
      tracking: candidate,
    };
  }
  const projected = orderedAlong(stops, leg);
  let next = current;
  // At most three occurrences per fix; the destination stays the next stop until explicit alighting.
  while (next < Math.min(current + 3, stops.length - 1) && snap.alongMeters > projected[next] + 25)
    next++;
  return {
    cursor: next,
    alongMeters: Math.max(alongMeters, snap.alongMeters),
    trusted: true,
    tracking: { alongTimestampMs: fix.timestampMs },
  };
}
