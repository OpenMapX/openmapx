import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { useMutation } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";

export interface TransitRefreshResult {
  itinerary: TripItinerary;
  fallbackOccurred: boolean;
}

export function useRefreshTransitItinerary() {
  return useMutation({
    mutationFn: (token: string) =>
      apiClient.post<MobilityEnvelope<TransitRefreshResult>>(API_ENDPOINTS.transitPlanRefresh, {
        token,
      }),
  });
}
