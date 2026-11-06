import type { TripItinerary } from "@openmapx/mobility-core/transit";

/** Stable source-qualified selection identity, also for providers without itinerary IDs. */
export function transitItineraryKey(itinerary: TripItinerary, provider?: string): string {
  const fallback = `${itinerary.startTime}|${itinerary.endTime}|${itinerary.legs
    .map((leg) => `${leg.tripId ?? leg.mode}:${leg.from.stopId ?? leg.from.name}`)
    .join("|")}`;
  return `${itinerary.source ?? provider ?? "unknown"}:${itinerary.id ?? fallback}`;
}
