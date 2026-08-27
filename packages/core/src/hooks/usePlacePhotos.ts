import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, DETAIL_QUERY_POLICY } from "../api/queryPolicy";
import type { PlacePhoto } from "../types/place";

interface PhotosResponse {
  photos: PlacePhoto[];
}

export function usePlacePhotos(
  lat: number | undefined,
  lng: number | undefined,
  options?: { name?: string; placeId?: string; limit?: number; enabled?: boolean },
) {
  return useQuery({
    queryKey: ["placePhotos", lat, lng, options?.placeId, options?.name, options?.limit],
    queryFn: ({ signal }) => {
      const params: Record<string, string> = {
        lat: String(lat),
        lng: String(lng),
      };
      if (options?.name) params.name = options.name;
      if (options?.placeId) params.placeId = options.placeId;
      if (options?.limit) params.limit = String(options.limit);
      return apiClient.get<PhotosResponse>(
        API_ENDPOINTS.photos,
        params,
        apiQueryRequestOptions(signal, DETAIL_QUERY_POLICY),
      );
    },
    enabled: (options?.enabled ?? true) && lat !== undefined && lng !== undefined,
    staleTime: 600_000,
    gcTime: DETAIL_QUERY_POLICY.gcTime,
    select: (data) => data.photos,
  });
}
