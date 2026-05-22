import type { ServiceAlert } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";

export function useRouteAlerts(routeId: string | null) {
  return useQuery({
    queryKey: ["route-alerts", routeId],
    queryFn: () =>
      apiClient.get<ServiceAlert[]>(
        `/api/integrations/transit/routes/${encodeURIComponent(routeId as string)}/alerts`,
      ),
    enabled: routeId !== null,
    staleTime: 60_000,
  });
}
