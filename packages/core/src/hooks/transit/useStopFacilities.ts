import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { Facility } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useStopFacilities(stopId: string | null): MobilityEnvelopeQueryResult<Facility[]> {
  const query = useQuery({
    queryKey: ["stop-facilities", stopId],
    queryFn: () =>
      apiClient.get<MobilityEnvelope<Facility[]>>(
        `/api/integrations/transit/stops/${encodeURIComponent(stopId as string)}/facilities`,
      ),
    enabled: stopId !== null,
    staleTime: 300_000,
  });
  return wrapMobilityEnvelope(query);
}
