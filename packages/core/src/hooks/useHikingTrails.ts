import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type {
  HikingFeatureCollection,
  HikingTrailDetail,
  HikingTrailSummary,
  ShelterFeatureCollection,
} from "../types/hiking";

export function useHikingSearch(query: string, limit = 20) {
  return useQuery({
    queryKey: ["hiking-search", query, limit],
    queryFn: () =>
      apiClient.get<HikingTrailSummary[]>(API_ENDPOINTS.hikingSearch, {
        query,
        limit: String(limit),
      }),
    enabled: query.trim().length >= 2,
    staleTime: 300_000,
  });
}

export function useHikingArea(
  south: number | null,
  west: number | null,
  north: number | null,
  east: number | null,
  limit = 50,
) {
  return useQuery({
    queryKey: ["hiking-area", south, west, north, east, limit],
    queryFn: () =>
      apiClient.get<HikingTrailSummary[]>(API_ENDPOINTS.hikingArea, {
        south: String(south),
        west: String(west),
        north: String(north),
        east: String(east),
        limit: String(limit),
      }),
    enabled: south !== null && west !== null && north !== null && east !== null,
    staleTime: 300_000,
  });
}

export function useHikingDetail(id: number | null) {
  return useQuery({
    queryKey: ["hiking-detail", id],
    queryFn: () => apiClient.get<HikingTrailDetail>(`${API_ENDPOINTS.hikingDetail}/${id}`),
    enabled: id !== null,
    staleTime: 3_600_000,
  });
}

export function useHikingGeometry(id: number | null) {
  return useQuery({
    queryKey: ["hiking-geometry", id],
    queryFn: () => apiClient.get<HikingFeatureCollection>(`${API_ENDPOINTS.hikingGeometry}/${id}`),
    enabled: id !== null,
    staleTime: 3_600_000,
  });
}

export function useHikingShelters(
  south: number | null,
  west: number | null,
  north: number | null,
  east: number | null,
  typeFilter?: string,
) {
  return useQuery({
    queryKey: ["hiking-shelters", south, west, north, east, typeFilter],
    queryFn: () => {
      const params: Record<string, string> = {
        south: String(south),
        west: String(west),
        north: String(north),
        east: String(east),
      };
      if (typeFilter) params.type = typeFilter;
      return apiClient.get<ShelterFeatureCollection>(API_ENDPOINTS.hikingShelters, params);
    },
    enabled: south !== null && west !== null && north !== null && east !== null,
    staleTime: 300_000,
  });
}
