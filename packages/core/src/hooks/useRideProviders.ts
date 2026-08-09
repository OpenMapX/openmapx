import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LngLat } from "../types/geometry";
import type { RideProvidersResponse } from "../types/ride";

/**
 * Fetch the ride providers serving a pickup (and, when known, a dropoff),
 * together with the operator's comparison policy. Keyed on rounded
 * coordinates so nudging the map by a metre does not refetch.
 */
export function useRideProviders(pickup: LngLat | null, dropoff: LngLat | null) {
  const key = pickup
    ? [pickup[0].toFixed(4), pickup[1].toFixed(4), dropoff?.[0].toFixed(4), dropoff?.[1].toFixed(4)]
    : null;

  return useQuery<RideProvidersResponse>({
    queryKey: ["ride-providers", key],
    enabled: pickup !== null,
    staleTime: 5 * 60 * 1000,
    queryFn: () => {
      if (!pickup) throw new Error("pickup required");
      const params: Record<string, string> = {
        pickupLat: String(pickup[1]),
        pickupLng: String(pickup[0]),
      };
      if (dropoff) {
        params.dropoffLat = String(dropoff[1]);
        params.dropoffLng = String(dropoff[0]);
      }
      return apiClient.get<RideProvidersResponse>(API_ENDPOINTS.rideProviders, params);
    },
  });
}
