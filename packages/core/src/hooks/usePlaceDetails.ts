import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { buildPlaceDetailsRequest } from "../api/placeDetails";
import {
  apiQueryRequestOptions,
  DETAIL_QUERY_POLICY,
  rateLimitAwareRetry,
} from "../api/queryPolicy";
import type { LngLat } from "../types/geometry";
import type { Place } from "../types/place";
import { isDisplayablePhoto } from "../utils/commons-metadata";

export function usePlaceDetails(
  placeId: string | null,
  coordinates?: LngLat,
  name?: string,
  lang?: string,
  hasAddress?: boolean,
) {
  const request =
    placeId !== null
      ? buildPlaceDetailsRequest({ id: placeId, coordinates, name, lang, hasAddress })
      : null;
  const fallbackRetry = useQueryClient().getDefaultOptions().queries?.retry;
  return useQuery({
    queryKey: ["place", request?.identity ?? null, 3],
    queryFn: ({ signal }) => {
      if (!request) throw new Error("place details query is disabled without an id");
      return apiClient.get<Place>(
        `${API_ENDPOINTS.places}/${encodeURIComponent(request.identity.id)}`,
        { ...request.params, fileMetadata: "3" },
        apiQueryRequestOptions(signal, DETAIL_QUERY_POLICY),
      );
    },
    enabled: request !== null,
    // A saved list loads details for each row, sharing the per-client
    // expensive budget with photos and the image proxy; wait out a 429.
    ...rateLimitAwareRetry(fallbackRetry),
    staleTime: 30_000,
    refetchInterval: 60_000,
    gcTime: DETAIL_QUERY_POLICY.gcTime,
    select: (data) =>
      data.photos ? { ...data, photos: data.photos.filter(isDisplayablePhoto) } : data,
  });
}
