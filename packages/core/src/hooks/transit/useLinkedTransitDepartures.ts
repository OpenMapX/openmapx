import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { Place } from "../../types/place";
import type { MergedDeparture } from "../../types/transit";
import { isTransitEligiblePlace } from "./transitEligibility";

export function useLinkedTransitDepartures(place: Place | null, minutes = 60) {
  const enabled = isTransitEligiblePlace(place);

  return useQuery({
    queryKey: [
      "linked-transit-departures",
      place?.id ?? place?.coordinates?.join(","),
      place?.name,
      minutes,
    ],
    queryFn: () => {
      const p = place as Place;
      return apiClient.get<MergedDeparture[]>(API_ENDPOINTS.transitDeparturesForPlace, {
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
