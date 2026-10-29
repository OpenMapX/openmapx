import { rankItineraries, type TransitRoutePreference } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";

/** Preserve the planner's source-qualified identity, including providers without itinerary IDs. */
function itineraryKey(itinerary: TripItinerary, provider: string | undefined): string {
  const fallback = `${itinerary.startTime}|${itinerary.endTime}|${itinerary.legs
    .map((leg) => `${leg.tripId ?? leg.mode}:${leg.from.stopId ?? leg.from.name}`)
    .join("|")}`;
  return `${itinerary.source ?? provider ?? "unknown"}:${itinerary.id ?? fallback}`;
}

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
    const key = itineraryKey(itinerary, provider);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return rankItineraries(deduped, preference);
}
