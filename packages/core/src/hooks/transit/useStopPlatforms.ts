import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useStopPlatforms(
  stopId: string | null,
): MobilityEnvelopeQueryResult<TransitStop[]> {
  const query = useQuery({
    queryKey: ["stop-platforms", stopId],
    queryFn: () => {
      const url = API_ENDPOINTS.transitStopPlatforms.replace(
        ":id",
        encodeURIComponent(stopId as string),
      );
      return apiClient.get<MobilityEnvelope<TransitStop[]>>(url);
    },
    enabled: stopId !== null,
    staleTime: 3_600_000,
  });
  return wrapMobilityEnvelope(query);
}
