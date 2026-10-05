import type { TransitStopArea, TripItinerary } from "@openmapx/mobility-core/transit";
import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchTransitStopArea } from "../../api/transit";
import {
  type TransitStopAreaIndex,
  transitStopsNeedingAreas,
} from "../../navigation/transitStopAreas";

const DAY_MS = 24 * 60 * 60 * 1000;

interface KeyedArea {
  key: string;
  area: TransitStopArea | null;
}

/** Module-level so React Query keeps the combined index stable between renders. */
function indexAreas(results: UseQueryResult<KeyedArea>[]): TransitStopAreaIndex {
  const index: Record<string, TransitStopArea> = {};
  for (const result of results) if (result.data?.area) index[result.data.key] = result.data.area;
  return index;
}

/**
 * The shapes of every stop a trip boards or alights at, keyed by stop id. A
 * stop whose lookup is pending, failed, or found nothing is simply absent, and
 * navigation treats it as a circle around its point until it arrives.
 */
export function useTransitStopAreas(itinerary: TripItinerary | null): TransitStopAreaIndex {
  const stops = useMemo(() => (itinerary ? transitStopsNeedingAreas(itinerary) : []), [itinerary]);
  return useQueries({
    queries: stops.map((stop) => ({
      queryKey: ["transit-stop-area", stop.stopId, stop.lat, stop.lng, stop.platform ?? null],
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<KeyedArea> => ({
        key: stop.key,
        area: await fetchTransitStopArea(stop, undefined, { signal }),
      }),
      staleTime: DAY_MS,
      gcTime: DAY_MS,
      retry: 1,
    })),
    combine: indexAreas,
  });
}
