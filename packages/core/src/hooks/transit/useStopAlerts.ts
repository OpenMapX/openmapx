import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { ServiceAlert } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useStopAlerts(stopId: string | null): MobilityEnvelopeQueryResult<ServiceAlert[]> {
  const query = useQuery({
    queryKey: ["stop-alerts", stopId],
    queryFn: ({ signal }) =>
      apiClient.get<MobilityEnvelope<ServiceAlert[]>>(
        `/api/integrations/transit/stops/${encodeURIComponent(stopId as string)}/alerts`,
        undefined,
        { signal },
      ),
    enabled: stopId !== null,
    staleTime: 60_000,
  });
  return wrapMobilityEnvelope(query);
}
