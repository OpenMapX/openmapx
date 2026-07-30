import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { RouteStop } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useRouteStops(
  routeId: string | null,
  hintStopId?: string | null,
): MobilityEnvelopeQueryResult<RouteStop[]> {
  // Routes with dedicated stop endpoints (mb:, tfl:, MOTIS ms:rp: patterns)
  // don't need a hint stop. All other providers derive stops from a
  // departure's trip detail, requiring a hint.
  const needsHint =
    routeId !== null &&
    !routeId.startsWith("mb:") &&
    !routeId.startsWith("tfl:") &&
    !routeId.startsWith("ms:rp:");
  const query = useQuery({
    queryKey: ["route-stops", routeId, hintStopId ?? null],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (hintStopId) params.hint_stop_id = hintStopId;
      return apiClient.get<MobilityEnvelope<RouteStop[]>>(
        `/api/integrations/transit/routes/${encodeURIComponent(routeId as string)}/stops`,
        Object.keys(params).length ? params : undefined,
      );
    },
    enabled: routeId !== null && (!needsHint || !!hintStopId),
    staleTime: 300_000,
  });
  return wrapMobilityEnvelope(query);
}
