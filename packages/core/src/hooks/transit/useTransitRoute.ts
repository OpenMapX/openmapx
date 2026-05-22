import type { TransitRoute } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";

export function useTransitRoute(routeId: string | null) {
  return useQuery({
    queryKey: ["transit-route", routeId],
    queryFn: () =>
      apiClient.get<TransitRoute>(
        `/api/integrations/transit/routes/${encodeURIComponent(routeId as string)}`,
      ),
    enabled: routeId !== null,
    staleTime: 300_000,
  });
}
