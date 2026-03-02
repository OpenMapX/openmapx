import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { SearchResult } from "../types/search";

// Phase 3 — wire up once the API gateway is running
export function useGeocoding(query: string) {
  return useQuery({
    queryKey: ["geocode", query],
    queryFn: () => apiClient.get<SearchResult[]>(API_ENDPOINTS.geocode, { q: query }),
    enabled: query.trim().length >= 3,
    staleTime: 60_000,
  });
}
