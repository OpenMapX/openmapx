import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { Place } from "../../types/place";
// Arrivals share the same shape as departures (scheduledAt, headsign, route, platform);
// no separate MergedArrival type is needed.
import type { MergedDeparture } from "../../types/transit";
import { isTransitEligiblePlace } from "./transitEligibility";

export function useLinkedTransitArrivals(place: Place | null, minutes = 60) {
  const enabled = isTransitEligiblePlace(place);

  return useQuery({
    queryKey: ["linked-transit-arrivals", place?.id ?? place?.coordinates?.join(","), minutes],
    queryFn: () => {
      if (!place) throw new Error("invariant: place must be non-null");
      const p = place;
      // The arrivals endpoint returns the same shape as departures.
      return apiClient.get<MergedDeparture[]>(API_ENDPOINTS.transitArrivalsForPlace, {
        lat: String(p.coordinates[1]),
        lng: String(p.coordinates[0]),
        name: p.name,
        place_id: p.id,
        minutes: String(minutes),
      });
    },
    enabled,
    staleTime: 0,
    refetchInterval: 30_000,
  });
}
