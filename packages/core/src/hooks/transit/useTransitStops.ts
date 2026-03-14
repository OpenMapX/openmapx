import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import type { BoundingBox } from "../../types/geometry";
import type { TransitStop, TransportMode } from "../../types/transit";

export function useTransitStops(bbox: BoundingBox | null, modes?: TransportMode[]) {
  return useQuery({
    queryKey: ["transit-stops", bbox, modes],
    queryFn: () => {
      const params: Record<string, string> = {
        sw_lat: String(bbox?.south),
        sw_lng: String(bbox?.west),
        ne_lat: String(bbox?.north),
        ne_lng: String(bbox?.east),
      };
      if (modes?.length) params.modes = modes.join(",");
      return apiClient.get<TransitStop[]>(API_ENDPOINTS.transitStops, params);
    },
    enabled: bbox !== null,
    staleTime: 300_000,
  });
}
