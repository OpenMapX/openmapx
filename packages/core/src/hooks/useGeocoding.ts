import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, RAPID_QUERY_POLICY } from "../api/queryPolicy";
import type { SearchResult } from "../types/geocoding";

export function useGeocoding(query: string, lang?: string) {
  return useQuery({
    queryKey: ["geocode", query, lang],
    queryFn: ({ signal }) =>
      apiClient.get<SearchResult[]>(
        API_ENDPOINTS.geocode,
        { q: query, ...(lang && { lang }) },
        apiQueryRequestOptions(signal, RAPID_QUERY_POLICY),
      ),
    enabled: query.trim().length >= 3,
    staleTime: 60_000,
    gcTime: RAPID_QUERY_POLICY.gcTime,
  });
}
