import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import type { Facility } from "../../types/transit";

export function useStopFacilities(stopId: string | null) {
  return useQuery({
    queryKey: ["stop-facilities", stopId],
    queryFn: () =>
      apiClient.get<Facility[]>(
        `/api/transit/stops/${encodeURIComponent(stopId as string)}/facilities`,
      ),
    enabled: stopId !== null,
    staleTime: 300_000,
  });
}
