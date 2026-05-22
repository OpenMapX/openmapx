import type { TransitRoute } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";

export function useRoutesForStop(stopId: string | null) {
  return useQuery({
    queryKey: ["routes-for-stop", stopId],
    queryFn: () =>
      apiClient.get<TransitRoute[]>(API_ENDPOINTS.transitRoutes, {
        stop_id: stopId as string,
      }),
    enabled: stopId !== null,
    staleTime: 300_000,
  });
}
