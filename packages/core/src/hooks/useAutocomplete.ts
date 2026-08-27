import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, RAPID_QUERY_POLICY } from "../api/queryPolicy";
import type { AutocompleteResult } from "../types/geocoding";
import { usePrefixPlaceholder } from "./usePrefixPlaceholder";

export function useAutocomplete(query: string, lang?: string) {
  const placeholderData = usePrefixPlaceholder<AutocompleteResult[]>("autocomplete", query, lang);
  return useQuery<AutocompleteResult[]>({
    queryKey: ["autocomplete", query, lang],
    queryFn: ({ signal }) =>
      apiClient.get<AutocompleteResult[]>(
        API_ENDPOINTS.autocomplete,
        {
          q: query,
          ...(lang && { lang }),
        },
        apiQueryRequestOptions(signal, RAPID_QUERY_POLICY),
      ),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
    gcTime: RAPID_QUERY_POLICY.gcTime,
    placeholderData,
  });
}
