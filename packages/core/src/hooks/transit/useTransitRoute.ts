import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitRoute } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useTransitRoute(routeId: string | null): MobilityEnvelopeQueryResult<TransitRoute> {
  const query = useQuery({
    queryKey: ["transit-route", routeId],
    queryFn: () =>
      apiClient.get<MobilityEnvelope<TransitRoute>>(
        `/api/integrations/transit/routes/${encodeURIComponent(routeId as string)}`,
      ),
    enabled: routeId !== null,
    staleTime: 300_000,
  });
  return wrapMobilityEnvelope(query);
}
