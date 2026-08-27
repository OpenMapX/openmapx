import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { apiQueryRequestOptions, RAPID_QUERY_POLICY } from "../api/queryPolicy";
import type { AirportType } from "../types/place";

/** Airport match returned by `knowledge-ourairports/search`. */
export interface AirportSearchHit {
  id: number;
  ident: string;
  name: string;
  type: AirportType;
  iata?: string;
  icao?: string;
  lat: number;
  lng: number;
  municipality?: string;
  isoCountry?: string;
  scheduledService: boolean;
}

interface AirportSearchResponse {
  matches: AirportSearchHit[];
}

/**
 * Search the OurAirports catalog by IATA / ICAO / name / keyword. Backed by
 * the in-memory index loaded once per API process. Returns up to `limit`
 * airports ranked by match strength (exact code → name prefix → name
 * substring → keyword), then by importance (large → small).
 */
export function useAirportSearch(query: string, limit = 8) {
  return useQuery<AirportSearchResponse>({
    queryKey: ["airport-search", query.trim(), limit],
    queryFn: ({ signal }) =>
      apiClient.get<AirportSearchResponse>(
        "/api/integrations/knowledge-ourairports/search",
        { q: query.trim(), limit: String(limit) },
        apiQueryRequestOptions(signal, RAPID_QUERY_POLICY),
      ),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
    gcTime: RAPID_QUERY_POLICY.gcTime,
  });
}
