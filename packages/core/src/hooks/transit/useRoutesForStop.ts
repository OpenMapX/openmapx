import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitRoute } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useRoutesForStop(
  stopId: string | null,
): MobilityEnvelopeQueryResult<TransitRoute[]> {
  const query = useQuery({
    queryKey: ["routes-for-stop", stopId],
    queryFn: () =>
      apiClient.get<MobilityEnvelope<TransitRoute[]>>(API_ENDPOINTS.transitRoutes, {
        stop_id: stopId as string,
      }),
    enabled: stopId !== null,
    staleTime: 300_000,
  });
  return wrapMobilityEnvelope(query);
}
