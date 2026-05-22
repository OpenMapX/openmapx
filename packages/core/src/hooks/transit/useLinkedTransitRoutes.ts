import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { MergedRoute } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { Place } from "../../types/place";
import { isTransitEligiblePlace } from "./transitEligibility";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useLinkedTransitRoutes(
  place: Place | null,
): MobilityEnvelopeQueryResult<MergedRoute[]> {
  const enabled = isTransitEligiblePlace(place);

  const query = useQuery({
    queryKey: ["linked-transit-routes", place?.id ?? place?.coordinates?.join(",")],
    queryFn: () => {
      if (!place) throw new Error("invariant: place must be non-null");
      const p = place;
      return apiClient.get<MobilityEnvelope<MergedRoute[]>>(API_ENDPOINTS.transitRoutesForPlace, {
        lat: String(p.coordinates[1]),
        lng: String(p.coordinates[0]),
        name: p.name,
        place_id: p.id,
      });
    },
    enabled,
    staleTime: 5 * 60 * 1000, // 5min
  });
  return wrapMobilityEnvelope(query);
}
