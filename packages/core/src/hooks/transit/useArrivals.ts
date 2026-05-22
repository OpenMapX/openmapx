import type { Departure } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";

export function useArrivals(stopId: string | null, minutes = 60) {
  return useQuery({
    queryKey: ["arrivals", stopId, minutes],
    queryFn: () =>
      apiClient.get<Departure[]>(
        `/api/integrations/transit/stops/${encodeURIComponent(stopId as string)}/arrivals`,
        {
          minutes: String(minutes),
        },
      ),
    enabled: stopId !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
