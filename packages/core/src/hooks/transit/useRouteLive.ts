import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { RouteLive } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

/** Returns live vehicle positions and active alerts for a route. Refetches every 15s. */
export function useRouteLive(routeId: string | null): MobilityEnvelopeQueryResult<RouteLive> {
  const query = useQuery({
    queryKey: ["route-live", routeId],
    queryFn: () => {
      const url = API_ENDPOINTS.transitRouteLive.replace(
        ":id",
        encodeURIComponent(routeId as string),
      );
      return apiClient.get<MobilityEnvelope<RouteLive>>(url);
    },
    enabled: routeId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  return wrapMobilityEnvelope(query);
}
