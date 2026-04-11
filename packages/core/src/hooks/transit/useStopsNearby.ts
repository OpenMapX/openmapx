import type { TransitStop, TransportMode } from "@integrations/transit/types";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { LngLat } from "../../types/geometry";

export function useStopsNearby(
  location: LngLat | null,
  radiusMeters = 500,
  modes?: TransportMode[],
) {
  return useQuery({
    queryKey: ["transit-stops-nearby", location, radiusMeters, modes],
    queryFn: () => {
      const params: Record<string, string> = {
        lat: String(location?.[1]),
        lng: String(location?.[0]),
        radius: String(radiusMeters),
      };
      if (modes?.length) params.modes = modes.join(",");
      return apiClient.get<TransitStop[]>(API_ENDPOINTS.transitStopsNearby, params);
    },
    enabled: location !== null,
    staleTime: 300_000,
  });
}
