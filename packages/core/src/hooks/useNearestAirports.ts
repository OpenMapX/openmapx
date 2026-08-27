import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY } from "../api/queryPolicy";
import type { LngLat } from "../types/geometry";
import type { AirportSearchHit } from "./useAirportSearch";

/** Nearest-airport match — a search hit plus its distance from the query point. */
export interface NearestAirportHit extends AirportSearchHit {
  distanceKm: number;
}

interface NearestAirportsResponse {
  matches: NearestAirportHit[];
}

/**
 * Resolve the nearest IATA airports to a coordinate (closest first, preferring
 * scheduled-service airports). Used to prefill the origin/destination airport
 * for a directions endpoint in the flights panel.
 */
export function useNearestAirports(coords: LngLat | null, limit = 5) {
  return useQuery<NearestAirportsResponse>({
    queryKey: ["airport-nearest", coords?.[0], coords?.[1], limit],
    queryFn: ({ signal }) =>
      apiClient.get<NearestAirportsResponse>(
        API_ENDPOINTS.airportNearest,
        {
          // coords are [lng, lat]
          lng: String(coords?.[0]),
          lat: String(coords?.[1]),
          limit: String(limit),
        },
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      ),
    enabled: coords !== null,
    staleTime: 60 * 60 * 1000,
    gcTime: MAP_QUERY_POLICY.gcTime,
  });
}
