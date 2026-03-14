import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import type { TransitRoute } from "../../types/transit";

export function useTransitRoute(routeId: string | null) {
  return useQuery({
    queryKey: ["transit-route", routeId],
    queryFn: () =>
      apiClient.get<TransitRoute>(`/api/transit/routes/${encodeURIComponent(routeId as string)}`),
    enabled: routeId !== null,
    staleTime: 300_000,
  });
}
