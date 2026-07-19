import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { StopTransfer } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

/**
 * Accessibility-annotated transfers out of a stop (foot/wheelchair durations,
 * elevator usage) from MOTIS. Cached long — transfer geometry is static.
 */
export function useStopTransfers(
  stopId: string | null,
): MobilityEnvelopeQueryResult<StopTransfer[]> {
  const query = useQuery({
    queryKey: ["stop-transfers", stopId],
    queryFn: () => {
      const url = API_ENDPOINTS.transitStopTransfers.replace(
        ":id",
        encodeURIComponent(stopId as string),
      );
      return apiClient.get<MobilityEnvelope<StopTransfer[]>>(url);
    },
    enabled: stopId !== null,
    staleTime: 60 * 60 * 1000,
  });
  return wrapMobilityEnvelope(query);
}
