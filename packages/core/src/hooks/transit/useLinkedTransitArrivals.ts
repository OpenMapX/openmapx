// Arrivals share the same shape as departures (scheduledAt, headsign, route, platform);
// no separate MergedArrival type is needed.
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { MergedDeparture } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { Place } from "../../types/place";
import { isTransitEligiblePlace } from "./transitEligibility";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useLinkedTransitArrivals(
  place: Place | null,
  minutes = 60,
): MobilityEnvelopeQueryResult<MergedDeparture[]> {
  const enabled = isTransitEligiblePlace(place);

  const query = useQuery({
    queryKey: ["linked-transit-arrivals", place?.id ?? place?.coordinates?.join(","), minutes],
    queryFn: () => {
      if (!place) throw new Error("invariant: place must be non-null");
      const p = place;
      // The arrivals endpoint returns the same shape as departures.
      return apiClient.get<MobilityEnvelope<MergedDeparture[]>>(
        API_ENDPOINTS.transitArrivalsForPlace,
        {
          lat: String(p.coordinates[1]),
          lng: String(p.coordinates[0]),
          name: p.name,
          place_id: p.id,
          minutes: String(minutes),
        },
      );
    },
    enabled,
    staleTime: 0,
    refetchInterval: 30_000,
  });
  return wrapMobilityEnvelope(query);
}
