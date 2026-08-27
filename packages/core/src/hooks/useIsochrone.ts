import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY } from "../api/queryPolicy";
import type { LngLat } from "../types/geometry";
import type { IsochroneResult, IsochroneTravelMode } from "../types/routing";

interface UseIsochroneParams {
  origin: LngLat | null;
  mode: IsochroneTravelMode;
  contourMinutes: number[];
  enabled?: boolean;
}

export function useIsochrone({ origin, mode, contourMinutes, enabled = true }: UseIsochroneParams) {
  const sorted = [...contourMinutes].sort((a, b) => a - b);

  return useQuery({
    queryKey: ["isochrone", origin, mode, sorted],
    queryFn: ({ signal }) =>
      apiClient.get<IsochroneResult>(
        API_ENDPOINTS.isochrone,
        {
          lat: String(origin?.[1]),
          lng: String(origin?.[0]),
          mode,
          contours: sorted.join(","),
        },
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      ),
    enabled: enabled && origin !== null && contourMinutes.length > 0,
    staleTime: 120_000,
    gcTime: MAP_QUERY_POLICY.gcTime,
  });
}
