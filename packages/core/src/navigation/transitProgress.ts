import type { TripItinerary } from "@openmapx/mobility-core/transit";
import type { LngLat } from "../types/geometry";
import { haversineDistance } from "../utils/coordinates";
import {
  asRouteMatcher,
  type PreparedRouteMatcher,
  prepareRouteMatcher,
  type RouteMatcherInput,
  reportPreparedMismatch,
  snapPreparedRoute,
} from "./routeMatcher";

export interface TransitProgress {
  currentLegIndex: number;
  snapped: LngLat;
  fractionAlongLeg: number;
  deviationMeters: number;
  arrived: boolean;
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
 * Follow-along progress for a planned transit itinerary. Snaps the raw fix onto
 * each leg's polyline and picks the leg with the smallest perpendicular
 * deviation — i.e. the leg the traveller is most plausibly on right now. There
 * is NO rerouting; this only reports where along the planned trip we are.
 *
 * `prepared` is the itinerary's leg index, retained by the caller across fixes.
 * Without it one is built here, which is correct but rebuilds on every fix.
 */
export function computeTransitProgress(
  itinerary: TripItinerary,
  raw: LngLat,
  prepared?: PreparedTransitProgress,
): TransitProgress {
  const legs = itinerary.legs ?? [];
  if (prepared && prepared.itinerary !== itinerary) reportPreparedMismatch("transit leg index");
  const index =
    prepared && prepared.itinerary === itinerary ? prepared : prepareTransitProgress(itinerary);

  let bestLegIndex = -1;
  let bestSnapped: LngLat = raw;
  let bestAlong = 0;
  let bestDeviation = Number.POSITIVE_INFINITY;
  let bestLength = 0;

  for (let i = 0; i < legs.length; i++) {
    const leg = index.legs[i];
    if (!leg) continue;
    const snap = snapPreparedRoute(leg.matcher, raw);
    if (snap.deviationMeters < bestDeviation) {
      bestDeviation = snap.deviationMeters;
      bestLegIndex = i;
      bestSnapped = snap.snapped;
      bestAlong = snap.alongMeters;
      bestLength = leg.lengthMeters;
    }
  }

  // No leg with usable geometry — degenerate itinerary.
  if (bestLegIndex === -1) {
    return {
      currentLegIndex: 0,
      snapped: raw,
      fractionAlongLeg: 0,
      deviationMeters: 0,
      arrived: false,
    };
  }

  const fractionAlongLeg = bestLength > 0 ? Math.max(0, Math.min(1, bestAlong / bestLength)) : 0;
  const arrived = bestLegIndex === legs.length - 1 && fractionAlongLeg >= 0.9;

  return {
    currentLegIndex: bestLegIndex,
    snapped: bestSnapped,
    fractionAlongLeg,
    deviationMeters: bestDeviation,
    arrived,
  };
}

/**
 * Detect a missed connection during transit follow-along: the next transit leg
 * the traveller still needs to board has a scheduled departure more than
 * `graceSec` in the past, yet they haven't actually boarded it (still on an
 * earlier leg, or barely onto it with a large deviation). Used to trigger an
 * on-trip replan from the current position. Deliberately conservative — it only
 * inspects the first upcoming transit leg to avoid false positives mid-trip.
 */
export function detectMissedConnection(
  itinerary: TripItinerary,
  progress: TransitProgress,
  nowMs: number,
  graceSec = 120,
): boolean {
  const legs = itinerary.legs ?? [];
  for (let i = progress.currentLegIndex; i < legs.length; i++) {
    const leg = legs[i];
    if (!leg.tripId) continue; // only transit legs have a catchable departure
    const dep = leg.startTime ? new Date(leg.startTime).getTime() : Number.NaN;
    if (!Number.isFinite(dep)) return false;
    if (nowMs <= dep + graceSec * 1000) return false; // departure not yet missed
    // You're aboard the leg you're currently snapped to (i === currentLegIndex)
    // if you've made real progress along it, OR if the fix is too unreliable to
    // trust: a transient deviation spike (tunnel, urban canyon) must not flip a
    // clearly-underway rider back to "missed". A low fraction with a SMALL
    // deviation means you're genuinely still at the stop — a real miss. The leg
    // is always at or ahead of the current one, so a future transit leg
    // (i > currentLegIndex) is never "boarded" → its missed departure is flagged.
    const boarded =
      i === progress.currentLegIndex &&
      (progress.fractionAlongLeg > 0.1 || progress.deviationMeters >= 150);
    return !boarded;
  }
  return false;
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
