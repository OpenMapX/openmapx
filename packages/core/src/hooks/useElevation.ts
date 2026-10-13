import {
  contributorsForRecordFields,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { ElevationApiResponse, ElevationProfile } from "../types/elevation";
import type { Route } from "../types/routing";
import { buildElevationProfile, buildElevationProfileFromApi } from "../utils/elevation";

interface UseElevationParams {
  route: Route | null;
  enabled?: boolean;
}

export function useElevation({ route, enabled = true }: UseElevationParams) {
  const isDriving = route?.mode === "driving";
  const hasInlineElevation = !isDriving && !!route?.elevation && route.elevation.length > 0;

  const profileInputContributors = useMemo(
    () => (route ? contributorsForRecordFields(route, ["geometry", "distance"]) : []),
    [route],
  );

  // For walking/cycling: compute profile from inline data (no fetch needed)
  const inlineProfile = useMemo<ElevationProfile | null>(() => {
    if (!route || !hasInlineElevation || !route.elevation) return null;
    return buildElevationProfile(route.geometry, route.elevation, route.elevationInterval ?? 30, {
      contributors: contributorsForRecordFields(route, [
        "geometry",
        "elevation",
        ...(route.elevationInterval === undefined ? [] : ["elevationInterval"]),
      ]),
    });
  }, [route, hasInlineElevation]);

  // For driving: fetch elevation from API
  const {
    data: fetchedProfile,
    isLoading: isFetching,
    isError,
  } = useQuery({
    queryKey: [
      "elevation-v2-contributors",
      // The computed profile owns this full shape and this historical geometry
      // receipt. Sparse coordinate keys could reuse a different route's profile.
      route?.geometry,
      route?.distance,
      profileInputContributors,
    ],
    queryFn: async () => {
      if (!route) throw new Error("No route");
      const geometry = route.geometry.map(([lng, lat]) => [lng, lat] as [number, number]);
      const data = await apiClient.post<ElevationApiResponse>(API_ENDPOINTS.elevation, {
        coordinates: geometry,
        routeDistance: route.distance,
      });
      return buildElevationProfileFromApi(geometry, data.points, {
        contributors: snapshotContributors(
          profileInputContributors,
          contributorsForRecordFields(data, ["points"]),
        ),
        ...(data.contributorCoverage || data.contributors === undefined
          ? { contributorCoverage: "partial" as const }
          : {}),
      });
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
