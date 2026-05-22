import type { TransitStopInfrastructure } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";

export function useStopInfrastructure(stopId: string | null) {
  return useQuery({
    queryKey: ["stop-infrastructure", stopId],
    queryFn: () => {
      const url = API_ENDPOINTS.transitStopInfrastructure.replace(
        ":id",
        encodeURIComponent(stopId as string),
      );
      return apiClient.get<TransitStopInfrastructure>(url);
    },
    enabled: stopId !== null,
    staleTime: 24 * 60 * 60 * 1000,
  });
}
