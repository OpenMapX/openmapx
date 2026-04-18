import type { Review, ReviewAggregate } from "@integrations/reviews/types";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";

interface ReviewsResponse {
  reviews: Review[];
}

interface AggregateResponse {
  aggregate: ReviewAggregate;
}

interface PlaceReviewsOpts {
  osmId?: string;
  enabled?: boolean;
}

/** Fetch the full list of reviews for a place (Mangrove + future providers). */
export function usePlaceReviews(
  lat: number | undefined,
  lng: number | undefined,
  name: string | undefined,
  opts?: PlaceReviewsOpts,
) {
  return useQuery({
    queryKey: ["placeReviews", lat, lng, name, opts?.osmId ?? null],
    enabled: (opts?.enabled ?? true) && lat !== undefined && lng !== undefined && !!name,
    staleTime: 300_000,
    queryFn: async () => {
      const params: Record<string, string> = {
        lat: String(lat),
        lng: String(lng),
        name: String(name),
      };
      if (opts?.osmId) params.osmId = opts.osmId;
      return apiClient.get<ReviewsResponse>(API_ENDPOINTS.reviews, params);
    },
    select: (data) => data.reviews,
  });
}

/** Fetch aggregate stars + count for a place. */
export function useReviewAggregate(
  lat: number | undefined,
  lng: number | undefined,
  name: string | undefined,
  opts?: PlaceReviewsOpts,
) {
  return useQuery({
    queryKey: ["placeReviewAggregate", lat, lng, name, opts?.osmId ?? null],
    enabled: (opts?.enabled ?? true) && lat !== undefined && lng !== undefined && !!name,
    staleTime: 300_000,
    queryFn: async () => {
      const params: Record<string, string> = {
        lat: String(lat),
        lng: String(lng),
        name: String(name),
      };
      if (opts?.osmId) params.osmId = opts.osmId;
      return apiClient.get<AggregateResponse>(API_ENDPOINTS.reviewAggregate, params);
    },
    select: (data) => data.aggregate,
  });
}
