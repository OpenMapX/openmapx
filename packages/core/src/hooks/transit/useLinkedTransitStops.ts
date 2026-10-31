import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { Place } from "../../types/place";
import { placeTransitKey, placeTransitParams } from "./placeTransitQuery";
import { isTransitEligiblePlace } from "./transitEligibility";
import {
  type MobilityEnvelopeQueryResult,
  mobilityEnvelopeTiming,
  wrapMobilityEnvelope,
} from "./useMobilityEnvelope";

interface LinkedTransitStopsOptions {
  enabled?: boolean;
}

export function useLinkedTransitStops(
  place: Place | null,
  options?: LinkedTransitStopsOptions,
): MobilityEnvelopeQueryResult<TransitStop[]> {
  const enabled = (options?.enabled ?? true) && isTransitEligiblePlace(place);

  const query = useQuery({
    queryKey: ["linked-transit-stops", ...placeTransitKey(place)],
    queryFn: () => {
      if (!place) throw new Error("invariant: place must be non-null");
      const p = place;
      return apiClient.get<MobilityEnvelope<TransitStop[]>>(API_ENDPOINTS.transitStopsNearPlace, {
        ...placeTransitParams(p),
      });
    },
    enabled,
    ...mobilityEnvelopeTiming(24 * 60 * 60 * 1000),
  });
  return wrapMobilityEnvelope(query);
}
