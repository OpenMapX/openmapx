import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { VehicleJourney } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { fetchVehicleJourney } from "../../api/transit";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useVehicleJourney(
  tripId: string | null,
  fallbackIds?: string[],
): MobilityEnvelopeQueryResult<VehicleJourney> {
  const query = useQuery({
    queryKey: ["vehicle-journey", tripId],
    queryFn: () => fetchVehicleJourney({ tripId: tripId as string, fallbackIds }),
    enabled: !!tripId,
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: 1,
  });
  return wrapMobilityEnvelope(query);
}
