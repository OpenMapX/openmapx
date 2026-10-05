import type { TripItinerary } from "@openmapx/mobility-core/transit";
import type { LngLat } from "../types/geometry";
import { haversineDistance } from "../utils/coordinates";
import {
  asRouteMatcher,
  type PreparedRouteMatcher,
  prepareRouteMatcher,
  type RouteMatcherInput,
  snapPreparedRoute,
} from "./routeMatcher";

export type TransitPhase = "walking" | "waiting-to-board" | "riding" | "transferring" | "arrived";

export interface TransitProgress {
  currentLegIndex: number;
  snapped: LngLat;
  fractionAlongLeg: number;
  deviationMeters: number;
  arrived: boolean;
  /** Where the rider is in the leg: walking to it, waiting at its stop, or aboard. */
  phase: TransitPhase;
}

/** One usable leg's prepared index and its total polyline length in metres. */
interface PreparedTransitLeg {
  readonly matcher: PreparedRouteMatcher;
  readonly lengthMeters: number;
}

/**
 * The per-leg indexes and lengths an itinerary needs for follow-along. Built
 * once per itinerary identity and reused for every fix; a replan produces a new
 * itinerary and therefore a new prepared object.
 */
export interface PreparedTransitProgress {
  readonly itinerary: TripItinerary;
  readonly legs: readonly (PreparedTransitLeg | null)[];
}

/** Total length of a polyline in metres (sum of segment haversine distances). */
function lineLength(coords: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineDistance(coords[i - 1], coords[i]);
  }
  return total;
}

/**
 * Index every leg of an itinerary that has usable geometry, together with its
 * length. Legs without a polyline hold a null slot so leg indices stay aligned.
 */
export function prepareTransitProgress(itinerary: TripItinerary): PreparedTransitProgress {
  const legs = (itinerary.legs ?? []).map((leg) => {
    const coords = leg.geometry?.coordinates as LngLat[] | undefined;
    if (!coords || coords.length < 2) return null;
    return { matcher: prepareRouteMatcher(coords), lengthMeters: lineLength(coords) };
  });
  return { itinerary, legs };
}

/**
 * Given the current leg polyline, its ordered stop list, and the snapped
 * position, work out the next stop and how many stops remain until alighting.
 * Each stop and the snapped point are projected onto the leg geometry to get a
 * comparable along-line distance, which is robust to GPS jitter and to stops
 * that aren't exactly on the polyline. The whole stop list shares the leg's
 * prepared index — the caller's, when it holds one across progress renders.
 */
export function stopsUntilAlight(
  leg: RouteMatcherInput,
  stops: { lat: number; lng: number; name: string }[],
  snapped: LngLat,
): { nextStopIndex: number; stopsRemaining: number; nextStopName: string | null } {
  const matcher = asRouteMatcher(leg);
  if (matcher.geometry.length < 2 || stops.length === 0) {
    return { nextStopIndex: -1, stopsRemaining: 0, nextStopName: null };
  }

  const snappedAlong = snapPreparedRoute(matcher, snapped).alongMeters;
  const stopAlong = stops.map((s) => snapPreparedRoute(matcher, [s.lng, s.lat]).alongMeters);

  // The next stop is the first stop strictly ahead of the snapped position.
  let nextStopIndex = -1;
  for (let i = 0; i < stops.length; i++) {
    if (stopAlong[i] > snappedAlong) {
      nextStopIndex = i;
      break;
    }
  }

  // Past the last stop (or at the alight stop) — nothing remaining.
  if (nextStopIndex === -1) {
    return { nextStopIndex: -1, stopsRemaining: 0, nextStopName: null };
  }

  const stopsRemaining = stops.length - nextStopIndex;
  return { nextStopIndex, stopsRemaining, nextStopName: stops[nextStopIndex].name };
}
