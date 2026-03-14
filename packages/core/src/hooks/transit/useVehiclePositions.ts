import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { VehiclePosition } from "../../types/transit";

export function useVehiclePositions(routeId: string | null) {
  return useQuery({
    queryKey: ["vehicle-positions", routeId],
    queryFn: () =>
      apiClient.get<VehiclePosition[]>(API_ENDPOINTS.transitVehicles, {
        route_id: routeId as string,
      }),
    enabled: routeId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}
