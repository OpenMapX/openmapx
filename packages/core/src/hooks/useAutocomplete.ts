import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { AutocompleteResult } from "../types/search";

// Phase 3 — wire up once the API gateway is running
export function useAutocomplete(query: string) {
  return useQuery({
    queryKey: ["autocomplete", query],
    queryFn: () => apiClient.get<AutocompleteResult[]>(API_ENDPOINTS.autocomplete, { q: query }),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
