import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { buildPlaceDetailsRequest } from "../api/placeDetails";
import { apiQueryRequestOptions, DETAIL_QUERY_POLICY } from "../api/queryPolicy";
import type { LngLat } from "../types/geometry";
import type { Place } from "../types/place";

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
  return useQuery({
    queryKey: ["place", request?.identity ?? null],
    queryFn: ({ signal }) => {
      if (!request) throw new Error("place details query is disabled without an id");
      return apiClient.get<Place>(
        `${API_ENDPOINTS.places}/${encodeURIComponent(request.identity.id)}`,
        request.params,
        apiQueryRequestOptions(signal, DETAIL_QUERY_POLICY),
      );
    },
    enabled: request !== null,
    staleTime: 300_000,
    gcTime: DETAIL_QUERY_POLICY.gcTime,
  });
}
