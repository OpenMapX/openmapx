import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { ServiceAlert } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { Place } from "../../types/place";
import { isTransitEligiblePlace } from "./transitEligibility";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useLinkedTransitAlerts(
  place: Place | null,
): MobilityEnvelopeQueryResult<ServiceAlert[]> {
  const enabled = isTransitEligiblePlace(place);

  const query = useQuery({
    queryKey: ["linked-transit-alerts", place?.id ?? place?.coordinates?.join(",")],
    queryFn: () => {
      if (!place) throw new Error("invariant: place must be non-null");
      const p = place;
      return apiClient.get<MobilityEnvelope<ServiceAlert[]>>(API_ENDPOINTS.transitAlertsForPlace, {
        lat: String(p.coordinates[1]),
        lng: String(p.coordinates[0]),
        name: p.name,
        place_id: p.id,
      });
    },
    enabled,
    staleTime: 60_000,
  });
  return wrapMobilityEnvelope(query);
}
