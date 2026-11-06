import { rankItineraries, type TransitRoutePreference } from "@openmapx/core";
import { transitItineraryFingerprint } from "@openmapx/core/navigation";
import type { TripItinerary } from "@openmapx/mobility-core/transit";

/** Stable identity survives object replacement and prefers authoritative records to composites. */
export function sameTransitItinerary(a: TripItinerary, b: TripItinerary): boolean {
  return (
    a.source === b.source &&
    a.instance === b.instance &&
    a.datasetEpoch === b.datasetEpoch &&
    ((Boolean(a.id) && a.id === b.id) ||
      (a.legs.length > 0 &&
        b.legs.length > 0 &&
        transitItineraryFingerprint(a) === transitItineraryFingerprint(b)))
  );
}
export function findTransitItinerary(
  items: readonly TripItinerary[],
  selected: TripItinerary,
): number {
  const reference = items.indexOf(selected);
  return reference >= 0 ? reference : items.findIndex((it) => sameTransitItinerary(it, selected));
}

/** Preserve the planner's source-qualified identity, including providers without itinerary IDs. */
function itineraryKey(itinerary: TripItinerary, provider: string | undefined): string {
  const fallback = `${itinerary.startTime}|${itinerary.endTime}|${itinerary.legs
    .map((leg) => `${leg.tripId ?? leg.mode}:${leg.from.stopId ?? leg.from.name}`)
    .join("|")}`;
  return `${itinerary.source ?? provider ?? "unknown"}:${itinerary.instance ?? ""}:${itinerary.datasetEpoch ?? ""}:${itinerary.id ?? fallback}`;
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
  const authoritative = combined.filter((it) => it.id);
  const seen = new Set<string>();
  const deduped = combined.filter((itinerary) => {
    if (!itinerary.id && authoritative.some((it) => sameTransitItinerary(it, itinerary)))
      return false;
    const key = itineraryKey(itinerary, provider);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return rankItineraries(deduped, preference);
}

/** Keep the current list and authoritative refresh identity; ignore callbacks from an older search. */
export function selectTransitAlternative(
  existing: readonly TripItinerary[],
  parent: TripItinerary,
  candidate: TripItinerary,
): { itineraries: TripItinerary[]; index: number } | null {
  const parentIndex = existing.indexOf(parent);
  if (parentIndex < 0) return null;
  const found = findTransitItinerary(existing, candidate);
  if (found >= 0) return { itineraries: [...existing], index: found };
  const itineraries = [...existing];
  itineraries.splice(parentIndex + 1, 0, candidate);
  return { itineraries, index: parentIndex + 1 };
}
