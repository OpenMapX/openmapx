import type { Facility } from "@integrations/transit/types";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";

export function useStopFacilities(stopId: string | null) {
  return useQuery({
    queryKey: ["stop-facilities", stopId],
    queryFn: () =>
      apiClient.get<Facility[]>(
        `/api/integrations/transit/stops/${encodeURIComponent(stopId as string)}/facilities`,
      ),
    enabled: stopId !== null,
    staleTime: 300_000,
  });
}
