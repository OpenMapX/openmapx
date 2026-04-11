import type { RouteLive } from "@integrations/transit/types";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";

/** Returns live vehicle positions and active alerts for a route. Refetches every 15s. */
export function useRouteLive(routeId: string | null) {
  return useQuery({
    queryKey: ["route-live", routeId],
    queryFn: () => {
      const url = API_ENDPOINTS.transitRouteLive.replace(
        ":id",
        encodeURIComponent(routeId as string),
      );
      return apiClient.get<RouteLive>(url);
    },
    enabled: routeId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}
