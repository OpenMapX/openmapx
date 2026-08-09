import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { RideAttribution, RideQuote, RideQuoteRequest } from "../types/ride";
import { rideQuoteBody } from "../utils/rideLink";

export interface RideQuoteResult {
  providerId: string;
  quotes: RideQuote[];
  attributions: RideAttribution[];
}

interface QuotesResponse {
  results: RideQuoteResult[];
}

export interface UseRideQuotesOptions {
  request: RideQuoteRequest | null;
  providerIds: string[];
  /** False while the panel is hidden or the user has gone idle. */
  enabled: boolean;
}

/**
 * Fetch quotes for the selected provider(s). Quotes are priced from a precise
 * origin and destination and expire in under a minute, so nothing is cached:
 * `gcTime` is zero and the result is never reused across a remount.
 */
export function useRideQuotes({ request, providerIds, enabled }: UseRideQuotesOptions) {
  const active = enabled && request !== null && providerIds.length > 0;

  const query = useQuery<QuotesResponse>({
    queryKey: [
      "ride-quotes",
      providerIds.join(","),
      request?.pickup.join(","),
      request?.dropoff?.join(","),
      request?.passengers,
      request?.pickupAt,
    ],
    enabled: active,
    gcTime: 0,
    staleTime: 0,
    queryFn: () => {
      if (!request) throw new Error("request required");
      return apiClient.post<QuotesResponse>(
        API_ENDPOINTS.rideQuotes,
        rideQuoteBody(request, providerIds),
      );
    },
  });

  const results = useMemo(() => query.data?.results ?? [], [query.data]);

  // The whole batch is only as fresh as its shortest-lived quote, so the panel
  // counts down to the earliest expiry rather than to a per-quote one.
  const expiresAt = useMemo(() => {
    const all = results.flatMap((r) => r.quotes.map((q) => q.expiresAt));
    if (all.length === 0) return null;
    return all.reduce((earliest, current) => (current < earliest ? current : earliest));
  }, [results]);

  return { results, isLoading: query.isLoading, expiresAt, refetch: query.refetch };
}
