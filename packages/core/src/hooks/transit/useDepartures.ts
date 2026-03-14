import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import type { Departure } from "../../types/transit";

export function useDepartures(stopId: string | null, minutes = 60) {
  return useQuery({
    queryKey: ["departures", stopId, minutes],
    queryFn: () =>
      apiClient.get<Departure[]>(
        `/api/transit/stops/${encodeURIComponent(stopId as string)}/departures`,
        {
          minutes: String(minutes),
        },
      ),
    enabled: stopId !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
