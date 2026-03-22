import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { Route } from "../types/directions";
import type { ElevationApiResponse, ElevationProfile } from "../types/elevation";
import { buildElevationProfile, buildElevationProfileFromApi } from "../utils/elevation";

interface UseElevationParams {
  route: Route | null;
  enabled?: boolean;
}

export function useElevation({ route, enabled = true }: UseElevationParams) {
  const isDriving = route?.mode === "driving";
  const hasInlineElevation = !isDriving && !!route?.elevation && route.elevation.length > 0;

  // For walking/cycling: compute profile from inline data (no fetch needed)
  const inlineProfile = useMemo<ElevationProfile | null>(() => {
    if (!route || !hasInlineElevation || !route.elevation) return null;
    return buildElevationProfile(route.geometry, route.elevation, route.elevationInterval ?? 30);
  }, [route, hasInlineElevation]);

  // For driving: fetch elevation from API
  const {
    data: fetchedProfile,
    isLoading: isFetching,
    isError,
  } = useQuery({
    queryKey: [
      "elevation",
      // Use first, last, and middle coords + total distance as a stable key
      route?.geometry[0],
      route?.geometry[Math.floor((route?.geometry.length ?? 0) / 2)],
      route?.geometry[(route?.geometry.length ?? 1) - 1],
      route?.distance,
    ],
    queryFn: async () => {
      if (!route) throw new Error("No route");
      const data = await apiClient.post<ElevationApiResponse>(API_ENDPOINTS.elevation, {
        coordinates: route.geometry,
        routeDistance: route.distance,
      });
      return buildElevationProfileFromApi(route.geometry, data.points);
    },
    enabled: enabled && isDriving && route !== null && route.geometry.length >= 2,
    staleTime: 300_000,
    gcTime: 600_000,
  });

  return {
    data: hasInlineElevation ? inlineProfile : isDriving ? (fetchedProfile ?? null) : null,
    isLoading: isDriving ? isFetching : false,
    isError,
  };
}
