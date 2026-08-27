import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitStop, TransportMode } from "@openmapx/mobility-core/transit";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY } from "../../api/queryPolicy";
import type { BoundingBox } from "../../types/geometry";
import { type MobilityEnvelopeQueryResult, wrapMobilityEnvelope } from "./useMobilityEnvelope";

export function useTransitStops(
  bbox: BoundingBox | null,
  modes?: TransportMode[],
): MobilityEnvelopeQueryResult<TransitStop[]> {
  const query = useQuery({
    queryKey: ["transit-stops", bbox, modes],
    queryFn: ({ signal }) => {
      const params: Record<string, string> = {
        sw_lat: String(bbox?.south),
        sw_lng: String(bbox?.west),
        ne_lat: String(bbox?.north),
        ne_lng: String(bbox?.east),
      };
      if (modes?.length) params.modes = modes.join(",");
      return apiClient.get<MobilityEnvelope<TransitStop[]>>(
        API_ENDPOINTS.transitStops,
        params,
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      );
    },
    enabled: bbox !== null,
    staleTime: 300_000,
    gcTime: MAP_QUERY_POLICY.gcTime,
  });
  return wrapMobilityEnvelope(query);
}
