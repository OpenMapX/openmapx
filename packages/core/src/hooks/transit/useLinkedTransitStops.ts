import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { Place } from "../../types/place";
import type { TransitStop } from "../../types/transit";
import { isTransitEligiblePlace } from "./transitEligibility";

export function useLinkedTransitStops(place: Place | null) {
  const enabled = isTransitEligiblePlace(place);

  return useQuery({
    queryKey: ["linked-transit-stops", place?.id ?? place?.coordinates?.join(","), place?.name],
    queryFn: () => {
      if (!place) throw new Error("invariant: place must be non-null");
      const p = place;
      return apiClient.get<TransitStop[]>(API_ENDPOINTS.transitStopsNearPlace, {
        lat: String(p.coordinates[1]),
        lng: String(p.coordinates[0]),
        name: p.name,
        place_id: p.id,
      });
    },
    enabled,
    staleTime: 24 * 60 * 60 * 1000, // 24h
  });
}
