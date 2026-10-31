import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { ServiceAlert } from "@openmapx/mobility-core/transit";
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

export function useLinkedTransitAlerts(
  place: Place | null,
): MobilityEnvelopeQueryResult<ServiceAlert[]> {
  const enabled = isTransitEligiblePlace(place);

  const query = useQuery({
    queryKey: ["linked-transit-alerts", ...placeTransitKey(place)],
    queryFn: () => {
      if (!place) throw new Error("invariant: place must be non-null");
      const p = place;
      return apiClient.get<MobilityEnvelope<ServiceAlert[]>>(API_ENDPOINTS.transitAlertsForPlace, {
        ...placeTransitParams(p),
      });
    },
    enabled,
    ...mobilityEnvelopeTiming(60_000),
  });
  return wrapMobilityEnvelope(query);
}
