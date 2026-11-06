import { rankItineraries, type TransitRoutePreference, transitItineraryKey } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";

/** Merge one page without altering its records or their captured contributor receipts. */
export function mergeTransitItineraryPage({
  existing,
  incoming,
  provider,
  page,
  preference,
}: {
  existing: readonly TripItinerary[];
  incoming: readonly TripItinerary[];
  provider?: string;
  page: "initial" | "previous" | "next";
  preference: TransitRoutePreference;
}): TripItinerary[] {
  const combined =
    page === "initial"
      ? [...incoming]
      : page === "previous"
        ? [...incoming, ...existing]
        : [...existing, ...incoming];
  const seen = new Set<string>();
  const deduped = combined.filter((itinerary) => {
    const key = transitItineraryKey(itinerary, provider);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return rankItineraries(deduped, preference);
}
