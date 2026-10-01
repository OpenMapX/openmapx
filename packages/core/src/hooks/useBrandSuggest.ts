import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, RAPID_QUERY_POLICY } from "../api/queryPolicy";
import type { BrandKind, BrandSuggestResponse } from "../types/brand";

export interface BrandSuggestOptions {
  enabled?: boolean;
  /** Keep only identities with this role, e.g. "brand" to leave out police or transit operators. */
  kind?: BrandKind;
}

/**
 * Brand autocomplete. `country` is the viewport's ISO 3166-1 alpha-2 code and
 * only affects ranking, so it is part of the query key but never gates the
 * request — a search still works before the country resolves.
 */
export function useBrandSuggest(
  query: string,
  country?: string,
  { enabled = true, kind }: BrandSuggestOptions = {},
) {
  return useQuery<BrandSuggestResponse>({
    queryKey: ["brand-suggest", query, country, kind],
    queryFn: ({ signal }) =>
      apiClient.get<BrandSuggestResponse>(
        API_ENDPOINTS.brandSuggest,
        { q: query, ...(country && { country }), ...(kind && { kind }) },
        apiQueryRequestOptions(signal, RAPID_QUERY_POLICY),
      ),
    enabled: enabled && query.trim().length >= 2,
    // The catalog only changes when the artifact is regenerated, so results are
    // effectively immutable for the life of a session.
    staleTime: 60 * 60 * 1000,
    gcTime: RAPID_QUERY_POLICY.gcTime,
  });
}
