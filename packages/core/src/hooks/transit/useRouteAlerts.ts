import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { ServiceAlert } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useRouteAlerts(
  routeId: string | null,
): MobilityEnvelopeQueryResult<ServiceAlert[]> {
  const query = useQuery({
    queryKey: ["route-alerts", routeId],
    queryFn: () =>
      apiClient.get<MobilityEnvelope<ServiceAlert[]>>(
        `/api/integrations/transit/routes/${encodeURIComponent(routeId as string)}/alerts`,
      ),
    enabled: routeId !== null,
    staleTime: 60_000,
  });
  return wrapMobilityEnvelope(query);
}
