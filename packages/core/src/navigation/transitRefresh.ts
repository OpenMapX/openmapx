import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { transitItineraryFingerprint } from "./transitPackage";
/** Live service updates must not undo an active walking repair or keep a gate for a moved platform. */
export function mergeTransitRefresh(
  current: TripItinerary,
  next: TripItinerary,
  activeLegIndex: number,
  walkRevision: number,
): { itinerary: TripItinerary; resetWalk: boolean } | null {
  if (transitItineraryFingerprint(current) !== transitItineraryFingerprint(next)) return null;
  const old = current.legs[activeLegIndex];
  const fresh = next.legs[activeLegIndex];
  if (old?.mode !== "walking" || fresh?.mode !== "walking")
    return { itinerary: next, resetWalk: false };
  const sameTarget =
    old.to.lng === fresh.to.lng &&
    old.to.lat === fresh.to.lat &&
    old.to.platformCode === fresh.to.platformCode;
  if (walkRevision > 0 && sameTarget)
    return {
      itinerary: {
        ...next,
        legs: next.legs.map((leg, i) =>
          i === activeLegIndex
            ? {
                ...fresh,
                geometry: old.geometry,
                steps: old.steps,
                distanceMeters: old.distanceMeters,
                durationSeconds: old.durationSeconds,
                contributors: old.contributors,
                fieldContributors: old.fieldContributors,
              }
            : leg,
        ),
      },
      resetWalk: false,
    };
  return {
    itinerary: next,
    resetWalk:
      !sameTarget ||
      JSON.stringify(old.geometry) !== JSON.stringify(fresh.geometry) ||
      JSON.stringify(old.steps) !== JSON.stringify(fresh.steps),
  };
}
