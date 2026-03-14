import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { Place } from "../../types/place";
import type { ServiceAlert } from "../../types/transit";
import { isTransitEligiblePlace } from "./transitEligibility";

export function useLinkedTransitAlerts(place: Place | null) {
  const enabled = isTransitEligiblePlace(place);

  return useQuery({
    queryKey: ["linked-transit-alerts", place?.id ?? place?.coordinates?.join(","), place?.name],
    queryFn: () => {
      const p = place as Place;
      return apiClient.get<ServiceAlert[]>(API_ENDPOINTS.transitAlertsForPlace, {
        lat: String(p.coordinates[1]),
        lng: String(p.coordinates[0]),
        name: p.name,
        place_id: p.id,
      });
    },
    enabled,
    staleTime: 60_000,
  });
}
