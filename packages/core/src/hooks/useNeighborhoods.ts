import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { BBox } from "../types/geometry";
import type { NeighborhoodsResponse } from "../types/neighborhood";

/**
 * Neighbourhoods within a city's bounding box (`[west, south, east, north]`),
 * for the city place panel. Returns an empty list (never throws) when no bbox
 * is supplied or the upstream Overpass query yields nothing.
 */
export function useNeighborhoods(bbox: BBox | null, lang?: string) {
  return useQuery({
    queryKey: ["neighborhoods", bbox, lang],
    queryFn: () =>
      apiClient.get<NeighborhoodsResponse>(API_ENDPOINTS.neighborhoods, {
        west: String(bbox?.[0]),
        south: String(bbox?.[1]),
        east: String(bbox?.[2]),
        north: String(bbox?.[3]),
        ...(lang && { lang }),
      }),
    enabled: bbox != null,
    staleTime: 24 * 60 * 60 * 1000,
  });
}
