import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { VehiclePosition } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useVehiclePositions(
  routeId: string | null,
): MobilityEnvelopeQueryResult<VehiclePosition[]> {
  const query = useQuery({
    queryKey: ["vehicle-positions", routeId],
    queryFn: () =>
      apiClient.get<MobilityEnvelope<VehiclePosition[]>>(API_ENDPOINTS.transitVehicles, {
        route_id: routeId as string,
      }),
    enabled: routeId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  return wrapMobilityEnvelope(query);
}
