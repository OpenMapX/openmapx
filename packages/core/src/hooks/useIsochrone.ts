import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LngLat } from "../types/geometry";
import type { IsochroneResult, IsochroneTravelMode } from "../types/isochrone";

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
    queryFn: () =>
      apiClient.get<IsochroneResult>(API_ENDPOINTS.isochrone, {
        lat: String(origin?.[1]),
        lng: String(origin?.[0]),
        mode,
        contours: sorted.join(","),
      }),
    enabled: enabled && origin !== null && contourMinutes.length > 0,
    staleTime: 120_000,
    gcTime: 600_000,
  });
}
