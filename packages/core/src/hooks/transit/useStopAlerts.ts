import type { ServiceAlert } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";

export function useStopAlerts(stopId: string | null) {
  return useQuery({
    queryKey: ["stop-alerts", stopId],
    queryFn: () =>
      apiClient.get<ServiceAlert[]>(
        `/api/integrations/transit/stops/${encodeURIComponent(stopId as string)}/alerts`,
      ),
    enabled: stopId !== null,
    staleTime: 60_000,
  });
}
