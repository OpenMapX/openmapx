import type { SearchResult } from "@integrations/geocoding/types";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";

export function useGeocoding(query: string, lang?: string) {
  return useQuery({
    queryKey: ["geocode", query, lang],
    queryFn: () =>
      apiClient.get<SearchResult[]>(API_ENDPOINTS.geocode, {
        q: query,
        ...(lang && { lang }),
      }),
    enabled: query.trim().length >= 3,
    staleTime: 60_000,
  });
}
