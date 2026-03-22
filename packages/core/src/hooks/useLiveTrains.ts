import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { VehiclePosition } from "../types/transit";

/** Fetches all live DB train positions. Polls every 15s when enabled. */
export function useLiveTrains(enabled: boolean) {
  return useQuery({
    queryKey: ["live-trains"],
    queryFn: () => apiClient.get<VehiclePosition[]>(API_ENDPOINTS.risMapsPositions),
    enabled,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}
