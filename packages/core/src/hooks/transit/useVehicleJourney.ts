import type { VehicleJourney } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";

export function useVehicleJourney(tripId: string | null, fallbackIds?: string[]) {
  return useQuery({
    queryKey: ["vehicle-journey", tripId],
    queryFn: () => {
      const url = API_ENDPOINTS.transitVehicleJourney.replace(
        ":id",
        encodeURIComponent(tripId as string),
      );
      const params: Record<string, string> = {};
      // Don't pre-encode — apiClient.get uses URLSearchParams which encodes automatically
      if (fallbackIds?.length) {
        params.fallback_ids = fallbackIds.join(",");
      }
      return apiClient.get<VehicleJourney>(url, Object.keys(params).length ? params : undefined);
    },
    enabled: !!tripId,
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: 1,
  });
}
