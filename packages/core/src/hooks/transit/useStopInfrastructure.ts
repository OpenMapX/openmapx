import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitStopInfrastructure } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useStopInfrastructure(
  stopId: string | null,
): MobilityEnvelopeQueryResult<TransitStopInfrastructure> {
  const query = useQuery({
    queryKey: ["stop-infrastructure", stopId],
    queryFn: () => {
      const url = API_ENDPOINTS.transitStopInfrastructure.replace(
        ":id",
        encodeURIComponent(stopId as string),
      );
      return apiClient.get<MobilityEnvelope<TransitStopInfrastructure>>(url);
    },
    enabled: stopId !== null,
    staleTime: 24 * 60 * 60 * 1000,
  });
  return wrapMobilityEnvelope(query);
}
