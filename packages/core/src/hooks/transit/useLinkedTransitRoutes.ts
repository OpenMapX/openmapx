import type { MergedRoute } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { Place } from "../../types/place";
import { isTransitEligiblePlace } from "./transitEligibility";

export function useLinkedTransitRoutes(place: Place | null) {
  const enabled = isTransitEligiblePlace(place);

  return useQuery({
    queryKey: ["linked-transit-routes", place?.id ?? place?.coordinates?.join(",")],
    queryFn: () => {
      if (!place) throw new Error("invariant: place must be non-null");
      const p = place;
      return apiClient.get<MergedRoute[]>(API_ENDPOINTS.transitRoutesForPlace, {
        lat: String(p.coordinates[1]),
        lng: String(p.coordinates[0]),
        name: p.name,
        place_id: p.id,
      });
    },
    enabled,
    staleTime: 5 * 60 * 1000, // 5min
  });
}
