import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import type { ServiceAlert } from "../../types/transit";

export function useStopAlerts(stopId: string | null) {
  return useQuery({
    queryKey: ["stop-alerts", stopId],
    queryFn: () =>
      apiClient.get<ServiceAlert[]>(
        `/api/transit/stops/${encodeURIComponent(stopId as string)}/alerts`,
      ),
    enabled: stopId !== null,
    staleTime: 60_000,
  });
}
