import { useQuery } from "@tanstack/react-query";
import { useMangroveTransport } from "./provider";

interface PlaceReviewsOpts {
  osmId?: string;
  enabled?: boolean;
}

/**
 * Fetch the full list of reviews for a place. The wire-format of an
 * individual review is host-defined — pass it as the `TReview` generic.
 */
export function usePlaceReviews<TReview = unknown>(
  lat: number | undefined,
  lng: number | undefined,
  name: string | undefined,
  opts?: PlaceReviewsOpts,
) {
  const transport = useMangroveTransport<TReview>();
  return useQuery({
    queryKey: ["placeReviews", lat, lng, name, opts?.osmId ?? null],
    enabled: (opts?.enabled ?? true) && lat !== undefined && lng !== undefined && !!name,
    staleTime: 300_000,
    queryFn: () =>
      transport.fetchPlaceReviews({
        lat: lat as number,
        lng: lng as number,
        name: name as string,
        osmId: opts?.osmId,
      }),
  });
}

/**
 * Fetch aggregate stars + count for a place. Host defines `TAggregate`.
 */
export function useReviewAggregate<TAggregate = unknown>(
  lat: number | undefined,
  lng: number | undefined,
  name: string | undefined,
  opts?: PlaceReviewsOpts,
) {
  const transport = useMangroveTransport<unknown, TAggregate>();
  return useQuery({
    queryKey: ["placeReviewAggregate", lat, lng, name, opts?.osmId ?? null],
    enabled: (opts?.enabled ?? true) && lat !== undefined && lng !== undefined && !!name,
    staleTime: 300_000,
    queryFn: () =>
      transport.fetchPlaceReviewAggregate({
        lat: lat as number,
        lng: lng as number,
        name: name as string,
        osmId: opts?.osmId,
      }),
  });
}
