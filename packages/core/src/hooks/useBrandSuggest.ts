import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { BrandSuggestResponse } from "../types/brand";

/**
 * Brand autocomplete. `country` is the viewport's ISO 3166-1 alpha-2 code and
 * only affects ranking, so it is part of the query key but never gates the
 * request — a search still works before the country resolves.
 */
export function useBrandSuggest(query: string, country?: string, enabled = true) {
  return useQuery<BrandSuggestResponse>({
    queryKey: ["brand-suggest", query, country],
    queryFn: () =>
      apiClient.get<BrandSuggestResponse>(API_ENDPOINTS.brandSuggest, {
        q: query,
        ...(country && { country }),
      }),
    enabled: enabled && query.trim().length >= 2,
    // The catalog only changes when the artifact is regenerated, so results are
    // effectively immutable for the life of a session.
    staleTime: 60 * 60 * 1000,
  });
}
