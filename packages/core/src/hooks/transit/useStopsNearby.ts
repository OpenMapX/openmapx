import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitStop, TransportMode } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY } from "../../api/queryPolicy";
import type { LngLat } from "../../types/geometry";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useStopsNearby(
  location: LngLat | null,
  radiusMeters = 500,
  modes?: TransportMode[],
): MobilityEnvelopeQueryResult<TransitStop[]> {
  const query = useQuery({
    queryKey: ["transit-stops-nearby", location, radiusMeters, modes],
    queryFn: ({ signal }) => {
      const params: Record<string, string> = {
        lat: String(location?.[1]),
        lng: String(location?.[0]),
        radius: String(radiusMeters),
      };
      if (modes?.length) params.modes = modes.join(",");
      return apiClient.get<MobilityEnvelope<TransitStop[]>>(
        API_ENDPOINTS.transitStopsNearby,
        params,
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      );
    },
    enabled: location !== null,
    staleTime: 300_000,
    gcTime: MAP_QUERY_POLICY.gcTime,
  });
  return wrapMobilityEnvelope(query);
}
