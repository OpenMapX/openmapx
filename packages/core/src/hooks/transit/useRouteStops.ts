import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import type { RouteStop } from "../../types/transit";

export function useRouteStops(routeId: string | null, hintStopId?: string | null) {
  // Routes with dedicated stop endpoints (mb:, tfl:) don't need a hint stop.
  // All other providers derive stops from a departure's trip detail, requiring a hint.
  const needsHint = routeId !== null && !routeId.startsWith("mb:") && !routeId.startsWith("tfl:");
  return useQuery({
    queryKey: ["route-stops", routeId, hintStopId ?? null],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (hintStopId) params.hint_stop_id = hintStopId;
      return apiClient.get<RouteStop[]>(
        `/api/transit/routes/${encodeURIComponent(routeId as string)}/stops`,
        Object.keys(params).length ? params : undefined,
      );
    },
    enabled: routeId !== null && (!needsHint || !!hintStopId),
    staleTime: 300_000,
  });
}
