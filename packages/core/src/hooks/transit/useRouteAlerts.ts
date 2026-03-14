import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import type { ServiceAlert } from "../../types/transit";

export function useRouteAlerts(routeId: string | null) {
  return useQuery({
    queryKey: ["route-alerts", routeId],
    queryFn: () =>
      apiClient.get<ServiceAlert[]>(
        `/api/transit/routes/${encodeURIComponent(routeId as string)}/alerts`,
      ),
    enabled: routeId !== null,
    staleTime: 60_000,
  });
}
