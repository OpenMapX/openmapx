import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { VehicleJourney } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useVehicleJourney(
  tripId: string | null,
  fallbackIds?: string[],
): MobilityEnvelopeQueryResult<VehicleJourney> {
  const query = useQuery({
    queryKey: ["vehicle-journey", tripId],
    queryFn: () => {
      const url = API_ENDPOINTS.transitVehicleJourney.replace(
        ":id",
        encodeURIComponent(tripId as string),
      );
      const params: Record<string, string> = {};
      // Don't pre-encode — apiClient.get uses URLSearchParams which encodes automatically
      if (fallbackIds?.length) {
        params.fallback_ids = fallbackIds.join(",");
      }
      return apiClient.get<MobilityEnvelope<VehicleJourney>>(
        url,
        Object.keys(params).length ? params : undefined,
      );
    },
    enabled: !!tripId,
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: 1,
  });
  return wrapMobilityEnvelope(query);
}
